/**
 * POST /api/v1/bank/activate-customer
 * Sprint 3: Bank passes KYC result → Zillion creates/activates customer wallet.
 * This is the integration hook into the bank's existing onboarding flow.
 * The bank has already done KYC — Zillion trusts the bank's verification.
 *
 * Auth: Bank API key (X-Bank-API-Key header)
 * Body: { bank_ref, phone, nin_hash?, bvn_hash?, tier, kyc_status }
 */
'use strict';

const { createClient } = require('@supabase/supabase-js');
const { createHmac }   = require('crypto');
const { verifyBankAuth } = require('../../lib/bank-auth');
const { resolveOrCreateZillionId } = require('../../lib/zillionId');

// Only used to resolve the unified identity correctly — the existing
// phoneHash/customerId derivation below is untouched, uses the raw
// phone exactly as it always has, and still works the same way for
// callers already integrated against it.
function normalisePhoneForIdentity(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('234')) return '+' + digits;
  if (digits.startsWith('0'))   return '+234' + digits.slice(1);
  return '+' + digits;
}

// FIX: previously fell back to a hardcoded, guessable secret when the
// real env var was unset — a full auth-bypass / privacy risk. Now fails
// loudly instead of silently using a weak, predictable key.
function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error('Server misconfigured: ' + name + ' is not set');
  return v;
}


function generateCustomerId(phone, bankRef) {
  return 'CUST-' + createHmac('sha256', mustEnv('JWT_SECRET'))
    .update(phone + bankRef).digest('hex').slice(0, 12).toUpperCase();
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

  const { bank_ref, phone, nin_hash, bvn_hash, tier = 1, kyc_status = 'VERIFIED' } = body;
  if (!bank_ref) return err(400, 'Missing bank_ref');
  if (!phone)    return err(400, 'Missing phone');
  if (!phone.match(/^\+?[0-9]{10,15}$/)) return err(400, 'Invalid phone format');

  const TIER_LIMITS = { 1: 5000000, 2: 20000000, 3: 9007199254740991 };
  const dailyLimit  = TIER_LIMITS[tier] || TIER_LIMITS[1];

  try {
  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );

  // Generate deterministic device_hash from phone (same as OTP flow uses)
  const phoneHash    = createHmac('sha256', mustEnv('SUPABASE_SERVICE_KEY'))
    .update(phone).digest('hex');
  const customerId   = generateCustomerId(phone, bank_ref);
  const now          = new Date().toISOString();

  let zillionId = null;
  try { zillionId = await resolveOrCreateZillionId(db, normalisePhoneForIdentity(phone), 'bank_customer'); }
  catch (e) { console.warn('[bank-activate-customer] zillion identity link failed (non-fatal):', e.message); }

  // Check if already activated
  const { data: existing } = await db.from('devices')
    .select('device_hash, kyc_tier').eq('phone_hash', phoneHash).limit(1);

  if (existing && existing.length > 0) {
    // Existing record predates zillion_id — link it now if it's missing,
    // same lazy-backfill approach used everywhere else for wallet identities.
    if (zillionId) {
      try {
        await db.from('devices').update({ zillion_id: zillionId }).eq('device_hash', existing[0].device_hash).is('zillion_id', null);
      } catch (e) { console.warn('[bank-activate-customer] backfill link failed (non-fatal):', e.message); }
    }
    return ok({
      success:           true,
      already_activated: true,
      customer_id:       customerId,
      phone_hash:        phoneHash,
      tier:              existing[0].kyc_tier || tier,
      message:           'Customer wallet already exists',
    });
  }

  // Create device record — wallet is ready to use
  const { error: devErr } = await db.from('devices').insert({
    device_hash:      phoneHash,
    phone_hash:       phoneHash,
    public_key_hex:   'BANK_ACTIVATED',  // set when customer first opens wallet
    kyc_tier:         tier,
    nin_hash:         nin_hash || null,
    bvn_hash:         bvn_hash || null,
    daily_limit_kobo: dailyLimit,
    last_sync:        now,
    registered_at:    now,
    status:           'ACTIVE',
    zillion_id:       zillionId,
  });

  if (devErr) return err(500, `Activation failed: ${devErr.message}`);

  console.log(`[bank-activate] ✅ ${auth.bank_id} activated customer ${customerId} tier=${tier}`);

  return ok({
    success:           true,
    already_activated: false,
    customer_id:       customerId,
    phone_hash:        phoneHash,
    tier,
    daily_limit_kobo:  dailyLimit,
    wallet_activated:  true,
    bank_ref,
    activated_at:      now,
    message:           `Wallet activated at Tier ${tier}. Customer can now send/receive Zil.`,
  });
  } catch (e) {
    console.error('[bank-activate-customer] unhandled error:', e.message);
    return err(500, 'Server error: ' + e.message);
  }
};
