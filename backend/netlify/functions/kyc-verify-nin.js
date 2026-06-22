/**
 * POST /api/v1/kyc/verify-nin
 * Sprint 2: NIN verification via Paystack Identity API.
 * On success: upgrades device to Tier 2 (₦200,000/day limit).
 * Stores hashed NIN — never stores the raw NIN number.
 *
 * Auth: OTP JWT
 * Body: { nin, first_name, last_name, dob }  (dob: YYYY-MM-DD)
 *
 * CBN Tier structure:
 *   Tier 1: phone only         → ₦50,000/day  (5,000,000 kobo)
 *   Tier 2: NIN verified       → ₦200,000/day (20,000,000 kobo)
 *   Tier 3: NIN + BVN + address → unlimited
 */
'use strict';

const { createClient } = require('@supabase/supabase-js');
const { createHmac }   = require('crypto');
const { verifyJWT }    = require('../../lib/validators');

const TIER2_LIMIT_KOBO = parseInt(process.env.TIER2_DAILY_LIMIT_KOBO || '20000000');

function hashNIN(nin, salt) {
  return createHmac('sha256', salt).update(nin.trim()).digest('hex');
}

async function verifyWithPaystack(nin, firstName, lastName, dob) {
  const apiKey = process.env.PAYSTACK_SECRET_KEY;
  if (!apiKey) throw new Error('PAYSTACK_SECRET_KEY not configured');

  const res = await fetch('https://api.paystack.co/identity/nin/verify', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ nin, first_name: firstName, last_name: lastName,
      date_of_birth: dob }),
  });

  const data = await res.json();
  if (!res.ok || !data.status)
    throw new Error(data.message || `Paystack NIN verification failed: ${res.status}`);

  return data.data; // { verified: true, first_name, last_name, ... }
}

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b    => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m)=> ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(
    event.headers.authorization || event.headers.Authorization || ''
  );
  if (!auth.valid) return err(401, auth.reason);

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const { nin, first_name, last_name, dob } = body;
  if (!nin)        return err(400, 'Missing nin');
  if (!first_name) return err(400, 'Missing first_name');
  if (!last_name)  return err(400, 'Missing last_name');
  if (!dob)        return err(400, 'Missing dob (YYYY-MM-DD)');

  // Basic NIN format check — 11 digits
  if (!/^\d{11}$/.test(nin.trim()))
    return err(400, 'NIN must be exactly 11 digits');

  const deviceId = auth.payload.sub;
  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );

  // Check device is not already Tier 2+
  const { data: device } = await db
    .from('devices').select('kyc_tier, nin_hash').eq('device_hash', deviceId).single();

  if (device?.kyc_tier >= 2)
    return ok({ success: true, already_verified: true, tier: device.kyc_tier,
      message: 'Already verified at Tier 2 or above' });

  // Verify NIN with Paystack
  let verifyResult;
  try {
    verifyResult = await verifyWithPaystack(nin, first_name, last_name, dob);
  } catch (e) {
    console.error('[kyc-nin] Verification failed:', e.message);
    // In dev/test without Paystack key — simulate success
    if (!process.env.PAYSTACK_SECRET_KEY) {
      console.warn('[kyc-nin] DEV MODE: No Paystack key — simulating NIN verification success');
      verifyResult = { verified: true };
    } else {
      return err(422, `NIN verification failed: ${e.message}`);
    }
  }

  if (!verifyResult?.verified && process.env.PAYSTACK_SECRET_KEY)
    return err(422, 'NIN could not be verified. Check the details and try again.');

  // Store hashed NIN and upgrade tier
  const ninHash = hashNIN(nin, process.env.SUPABASE_SERVICE_KEY || 'zillion-salt');
  const { error: updateErr } = await db.from('devices').upsert({
    device_hash:     deviceId,
    nin_hash:        ninHash,
    kyc_tier:        2,
    daily_limit_kobo: TIER2_LIMIT_KOBO,
    last_sync:       new Date().toISOString(),
    status:          'ACTIVE',
  }, { onConflict: 'device_hash', ignoreDuplicates: false });

  if (updateErr) return err(500, `Failed to update KYC tier: ${updateErr.message}`);

  console.log(`[kyc-nin] ✅ Device ${deviceId.slice(0,12)}... upgraded to Tier 2`);

  return ok({
    success:       true,
    tier:          2,
    tier_upgraded: true,
    daily_limit_kobo: TIER2_LIMIT_KOBO,
    daily_limit_naira: TIER2_LIMIT_KOBO / 100,
    message:       'NIN verified. Daily limit upgraded to ₦200,000.',
  });
};
