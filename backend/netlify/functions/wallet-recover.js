'use strict';
/**
 * POST /api/v1/wallet-recover
 * Recovers coins for a wallet that lost its localStorage.
 * Auth: Customer device JWT (phone verified via OTP login)
 * Body: { phone, device_id, holder_hash }
 * Returns: { coins: [...], recovered_count, total_kobo }
 */
const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const crypto               = require('crypto');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b    => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m)=> ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Invalid or expired token');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const db       = getServiceClient();
  const now      = new Date().toISOString();

  // Get phone from JWT or body
  let phone = body.phone || auth.payload.phone || auth.payload.sub || '';
  // Normalise phone
  phone = phone.replace(/\s/g, '');
  if (phone.startsWith('0') && phone.length === 11) phone = '+234' + phone.slice(1);
  if (!phone.startsWith('+')) phone = '+' + phone;

  if (!phone || phone.length < 10) return err(400, 'Phone number required');

  // Compute canonical holder_hash = SHA256(phone)
  const canonicalHash = crypto.createHash('sha256').update(phone).digest('hex');

  // Search 1: coins already under canonical hash (HELD)
  const { data: coins1 } = await db.from('coins')
    .select('coin_id, amount, status, holder_hash, issuer_id, issued_at')
    .eq('holder_hash', canonicalHash)
    .eq('status', 'HELD');

  // Search 2: find the device record to get old holder_hash
  const deviceId = body.device_id || auth.payload.sub || '';
  let oldHashes = [];

  if (deviceId) {
    const { data: dev } = await db.from('devices').select('holder_hash, phone_hash')
      .eq('device_hash', deviceId).maybeSingle();
    if (dev?.holder_hash && dev.holder_hash !== canonicalHash) {
      oldHashes.push(dev.holder_hash);
    }
  }

  // Search 3: phone_hash from JWT
  if (auth.payload.phone_hash && !oldHashes.includes(auth.payload.phone_hash)) {
    oldHashes.push(auth.payload.phone_hash);
  }

  // Search 4: find any agent-issued coins where recipient could be this phone
  // by searching all HELD coins from agents issued in last 90 days
  let coins2 = [];
  for (const oldHash of oldHashes) {
    const { data: byOld } = await db.from('coins')
      .select('coin_id, amount, status, holder_hash, issuer_id, issued_at')
      .eq('holder_hash', oldHash)
      .eq('status', 'HELD');
    if (byOld && byOld.length > 0) {
      coins2 = [...coins2, ...byOld];
      // Re-assign these coins to canonical hash
      for (const coin of byOld) {
        await db.from('coins').update({
          holder_hash: canonicalHash,
          updated_at:  now,
        }).eq('coin_id', coin.coin_id);
      }
    }
  }

  // Update device record with canonical hash and phone
  if (deviceId) {
    await db.from('devices').upsert({
      device_hash:   deviceId,
      holder_hash:   canonicalHash,
      phone_number:  phone,
      phone_hash:    auth.payload.phone_hash || canonicalHash,
      public_key_hex:'PENDING',
      last_sync:     now,
      registered_at: now,
      status:        'ACTIVE',
    }, { onConflict: 'device_hash', ignoreDuplicates: false });
  }

  // Combine all found coins (deduplicate)
  const allCoinIds = new Set();
  const allCoins   = [];
  for (const c of [...(coins1||[]), ...coins2]) {
    if (!allCoinIds.has(c.coin_id)) {
      allCoinIds.add(c.coin_id);
      allCoins.push({ ...c, holder_hash: canonicalHash });
    }
  }

  const totalKobo = allCoins.reduce((s,c) => s + (c.amount||0), 0);

  return ok({
    success:         true,
    phone,
    canonical_hash:  canonicalHash,
    recovered_count: allCoins.length,
    total_kobo:      totalKobo,
    coins:           allCoins,
    message:         allCoins.length > 0
      ? `Recovered ${allCoins.length} coins totalling ₦${(totalKobo/100).toFixed(2)}`
      : 'No coins found for this phone number',
  });
};
