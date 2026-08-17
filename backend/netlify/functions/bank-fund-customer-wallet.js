/**
 * POST /api/v1/bank/fund-customer-wallet
 *
 * Bank-initiated direct customer wallet funding — the server-to-server
 * half of USSD self-load (or any bank-channel top-up): the bank owns the
 * interactive session and debits the customer's account on THEIR side;
 * once that's confirmed, they call this to credit the customer's Zillion
 * wallet. Mirrors the proven bank-fund-agent-float.js pattern (same
 * idempotency approach, same mint pipeline) but credits a customer's own
 * wallet identity instead of an agent's float pool.
 *
 * Auth: Bank API key (verifyBankAuth)
 * Body: { customer_phone, amount_kobo, bank_ref, denomination_kobo? }
 *
 * customer_phone is normalised and hashed the same way the wallet itself
 * computes its identity (plain SHA256(normalised_phone) — see agent's
 * ownerHash()), so coins land directly in the customer's existing vault
 * with no separate claim step needed.
 */
'use strict';

const crypto = require('crypto');
const { issueCoinBatch }   = require('../../lib/mint');
const { getServiceClient } = require('../../lib/supabase');
const { verifyBankAuth }   = require('../../lib/bank-auth');
const { logAlert }         = require('../../lib/alerts');

function normalisePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('234')) return '+' + digits;
  if (digits.startsWith('0'))   return '+234' + digits.slice(1);
  return '+' + digits;
}

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b    => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m)=> ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyBankAuth(event);
  if (!auth.valid) return err(401, auth.reason);

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const {
    customer_phone,
    amount_kobo,
    bank_ref,
    denomination_kobo = 100000, // default ₦1,000 coins
  } = body;

  if (!customer_phone)                    return err(400, 'Missing customer_phone');
  if (!amount_kobo || amount_kobo <= 0)   return err(400, 'amount_kobo must be positive');
  if (!bank_ref)                          return err(400, 'Missing bank_ref (bank transaction reference)');
  if (!Number.isInteger(amount_kobo))     return err(400, 'amount_kobo must be an integer');
  if (amount_kobo > 100_000_000)          return err(400, 'Exceeds single top-up limit of ₦1,000,000');
  if (amount_kobo % denomination_kobo !== 0)
    return err(400, `amount_kobo must be divisible by denomination_kobo (${denomination_kobo})`);

  if (!process.env.ZILLION_KMS_KEY_ARN && !process.env.MINT_PRIVATE_KEY_HEX)
    return err(500, 'No signing method configured');

  const db  = getServiceClient();

  // FIX: x-bank-id was previously a completely unvalidated, self-reported
  // string — anyone with the (single, shared) BANK_API_KEY could claim to
  // be any bank, and coins minted here never recorded which bank actually
  // funded them at all. Now validated against real, active mfb_partners
  // before it's trusted for anything, and used to correctly tag every
  // coin minted here — this is what makes a genuine "balance broken down
  // by bank" view possible at all for bank-funded top-ups.
  const { data: mfb, error: mfbErr } = await db
    .from('mfb_partners')
    .select('mfb_id, mfb_name, status')
    .eq('mfb_id', auth.bank_id)
    .single();
  if (mfbErr || !mfb)
    return err(400, `x-bank-id "${auth.bank_id}" does not match a registered participating bank. Contact Zillion to confirm your correct bank identifier.`);
  if (mfb.status !== 'ACTIVE')
    return err(403, `${mfb.mfb_name} is not currently an active partner (status: ${mfb.status})`);

  const now = new Date().toISOString();
  const normalisedPhone = normalisePhone(customer_phone);
  // Same scheme as agent's ownerHash() — plain SHA256(phone), matching
  // what the customer's OWN wallet computes as its identity. Not the
  // HMAC-with-secret scheme devices.phone_hash uses (see earlier session
  // finding: those are two genuinely different, non-comparable schemes).
  const holderHash = crypto.createHash('sha256').update(normalisedPhone).digest('hex');

  // Idempotency — same approach as bank-fund-agent-float.js
  // FIX: namespaced with an endpoint-specific prefix internally, so the
  // same bank_ref value can never collide with bank-fund-agent-float.js,
  // which shares this same underlying table for its own idempotency
  // check. Purely internal — bank_ref is still returned to the caller
  // exactly as they sent it.
  const idempotencyKey = `CUSTOMER:${bank_ref}`;
  const { data: existing } = await db.from('float_topups')
    .select('id').eq('deposit_ref', idempotencyKey).limit(1);
  if (existing && existing.length > 0)
    return ok({ success: true, idempotent: true, bank_ref,
      message: 'Wallet already funded for this bank_ref' });

  let coins;
  try {
    coins = await issueCoinBatch({
      totalAmountKobo:  amount_kobo,
      coinValueKobo:    denomination_kobo,
      recipientPhone:   normalisedPhone,
      recipientDevice:  holderHash,
      agentId:          `BANK:${auth.bank_id}`,
      mintPrivateKey:   process.env.MINT_PRIVATE_KEY_HEX,
      mintId:           process.env.MINT_ID || 'ZILLION-MINT-01',
      ownerSalt:        process.env.SUPABASE_SERVICE_KEY,
    });
  } catch (e) {
    return err(500, `Mint failed: ${e.message}`);
  }

  if (coins.length > 0) {
    try {
      await db.from('coins').insert(coins.map(c => ({
        coin_id:          c.coin_id,
        amount:           c.amount,
        currency:         c.currency || 'NGN',
        status:           'HELD', // straight to HELD — customer already owns it, no claim step
        issuer_id:        `BANK:${auth.bank_id}`,
        holder_hash:      holderHash,
        owner_hash:       holderHash,
        mfb_id:           mfb.mfb_id,
        issued_at:        c.issued_at,
        expires_at:       c.expires_at,
        signature:        c.signature,
        payload_hash:     c.payload_hash,
      })));
    } catch (e) {
      console.error('[bank-fund-customer-wallet] Coin insert failed:', e.message);
      await logAlert(db, {
        severity: 'CRITICAL',
        source:   'bank-fund-customer-wallet',
        message:  `Coins minted but failed to insert for bank_ref ${bank_ref} — customer may not see funds`,
        context:  { bank_ref, bank_id: auth.bank_id, amount_kobo, coin_ids: coins.map(c => c.coin_id) },
      });
      return err(500, `Mint succeeded but storage failed: ${e.message}. Contact Zillion support with bank_ref ${bank_ref} before retrying.`);
    }
  }

  // Audit log — reuses float_topups for consistency with the agent-funding
  // path and idempotency checking above; agent_id holds the bank marker
  // instead of a real agent for this customer-funding case.
  try {
    await db.from('float_topups').insert({
      agent_id:      `CUSTOMER:${holderHash.slice(0, 16)}`,
      amount_kobo,
      denomination_kobo,
      coin_count:    coins.length,
      first_coin_id: coins[0]?.coin_id,
      last_coin_id:  coins[coins.length - 1]?.coin_id,
      deposit_ref:   idempotencyKey,
      approved_by:   `BANK:${auth.bank_id}`,
      created_at:    now,
    });
  } catch (e) { console.warn('[bank-fund-customer-wallet] audit log non-fatal:', e.message); }

  console.log(`[bank-fund-customer-wallet] ✅ ${auth.bank_id} funded ${normalisedPhone} ₦${amount_kobo/100} ref=${bank_ref}`);

  return ok({
    success:          true,
    bank_ref,
    coins_minted:     coins.length,
    amount_kobo,
    denomination_kobo,
    first_coin_id:    coins[0]?.coin_id,
    funded_at:        now,
  });
};
