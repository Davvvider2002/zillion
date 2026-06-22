/**
 * POST /api/v1/bank/fund-agent-float
 * Sprint 3: Bank debits GL account → Zillion mints coins into agent float.
 * This is the bank-initiated version of admin-float-topup.
 * Bank calls this when an agent deposits cash at the bank branch.
 *
 * Auth: Bank API key
 * Body: { agent_id, amount_kobo, bank_ref, gl_account?, denomination_kobo? }
 */
'use strict';

const { issueCoinBatch }   = require('../../lib/mint');
const { getServiceClient } = require('../../lib/supabase');
const { verifyBankAuth }   = require('../../lib/bank-auth');

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
    agent_id,
    amount_kobo,
    bank_ref,
    gl_account    = 'DEFAULT',
    denomination_kobo = 100000,  // default ₦1,000 coins
  } = body;

  if (!agent_id)                          return err(400, 'Missing agent_id');
  if (!amount_kobo || amount_kobo <= 0)   return err(400, 'amount_kobo must be positive');
  if (!bank_ref)                          return err(400, 'Missing bank_ref (GL transaction reference)');
  if (!Number.isInteger(amount_kobo))     return err(400, 'amount_kobo must be an integer');
  if (amount_kobo > 100_000_000)          return err(400, 'Exceeds single top-up limit of ₦1,000,000');
  if (amount_kobo % denomination_kobo !== 0)
    return err(400, `amount_kobo must be divisible by denomination_kobo (${denomination_kobo})`);

  if (!process.env.ZILLION_KMS_KEY_ARN && !process.env.MINT_PRIVATE_KEY_HEX)
    return err(500, 'No signing method configured');

  const db  = getServiceClient();
  const now = new Date().toISOString();

  // Verify agent exists
  const { data: agent, error: agentErr } = await db.from('agents')
    .select('agent_id, float_balance_kobo, phone').eq('agent_id', agent_id).single();
  if (agentErr || !agent) return err(404, `Agent not found: ${agent_id}`);

  // Check for duplicate bank_ref (idempotency)
  const { data: existing } = await db.from('float_topups')
    .select('id').eq('deposit_ref', bank_ref).limit(1);
  if (existing && existing.length > 0)
    return ok({ success: true, idempotent: true, bank_ref,
      message: 'Float already funded for this bank_ref' });

  // Mint coins
  let coins;
  try {
    coins = await issueCoinBatch({
      totalAmountKobo:  amount_kobo,
      coinValueKobo:    denomination_kobo,
      recipientPhone:   agent.phone || agent_id,
      recipientDevice:  agent_id,
      agentId:          agent_id,
      mintPrivateKey:   process.env.MINT_PRIVATE_KEY_HEX,
      mintId:           process.env.MINT_ID || 'ZILLION-MINT-01',
      ownerSalt:        process.env.SUPABASE_SERVICE_KEY,
    });
  } catch (e) {
    return err(500, `Mint failed: ${e.message}`);
  }

  // Insert coins to Supabase
  if (coins.length > 0) {
    try {
      await db.from('coins').insert(coins.map(c => ({
        coin_id:          c.coin_id,
        amount:           c.amount,
        currency:         c.currency || 'NGN',
        status:           'ISSUED',
        issuer_id:        agent_id,
        holder_hash:      agent_id,
        owner_hash:       agent_id,
        issued_at:        c.issued_at,
        expires_at:       c.expires_at,
        signature:        c.signature,
        payload_hash:     c.payload_hash,
      })));
    } catch(e) { console.warn('[bank-fund-float] Coin insert warn:', e.message); }
  }

  // Update agent float
  const newFloat = (agent.float_balance_kobo || 0) + amount_kobo;
  await db.from('agents').update({ float_balance_kobo: newFloat }).eq('agent_id', agent_id);

  // Audit log in float_topups
  try {
    await db.from('float_topups').insert({
    agent_id,
    amount_kobo,
    denomination_kobo,
    coin_count:    coins.length,
    first_coin_id: coins[0]?.coin_id,
    last_coin_id:  coins[coins.length - 1]?.coin_id,
    deposit_ref:   bank_ref,
    approved_by:   `BANK:${auth.bank_id}:${gl_account}`,
    created_at:    now,
  });
  } catch(e) { console.warn('[supabase] non-fatal:', e.message); }

  console.log(`[bank-fund-float] ✅ ${auth.bank_id} funded ${agent_id} ₦${amount_kobo/100} ref=${bank_ref}`);

  return ok({
    success:          true,
    agent_id,
    bank_ref,
    gl_account,
    coins_minted:     coins.length,
    amount_kobo,
    denomination_kobo,
    new_float_kobo:   newFloat,
    first_coin_id:    coins[0]?.coin_id,
    funded_at:        now,
  });
};
