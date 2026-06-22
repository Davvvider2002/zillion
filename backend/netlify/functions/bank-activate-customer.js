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

function generateCustomerId(phone, bankRef) {
  return 'CUST-' + createHmac('sha256', process.env.JWT_SECRET || 'zillion')
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

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );

  // Generate deterministic device_hash from phone (same as OTP flow uses)
  const phoneHash    = createHmac('sha256', process.env.SUPABASE_SERVICE_KEY || 'salt')
    .update(phone).digest('hex');
  const customerId   = generateCustomerId(phone, bank_ref);
  const now          = new Date().toISOString();

  // Check if already activated
  const { data: existing } = await db.from('devices')
    .select('device_hash, kyc_tier').eq('phone_hash', phoneHash).limit(1);

  if (existing && existing.length > 0) {
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
};
