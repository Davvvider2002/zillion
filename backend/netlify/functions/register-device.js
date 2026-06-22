/**
 * POST /api/v1/register-device
 * Sprint 2: Stores the wallet device's Ed25519 public key in the registry.
 * Called once on first login after the wallet generates a key pair via SubtleCrypto.
 * This replaces the 'PENDING' placeholder and enables offline signature verification.
 *
 * Auth: OTP JWT (same token from verify-otp)
 * Body: { device_id, public_key_hex, key_algorithm? }
 */
'use strict';

const { createClient } = require('@supabase/supabase-js');
const { verifyJWT }    = require('../../lib/validators');

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

  const { device_id, public_key_hex, key_algorithm = 'ECDSA_P256' } = body;

  if (!device_id)       return err(400, 'Missing device_id');
  if (!public_key_hex)  return err(400, 'Missing public_key_hex');

  // Validate key format: should be hex string, minimum 64 chars (P-256 public key = 65 bytes = 130 hex)
  if (!/^[0-9a-fA-F]{64,}$/.test(public_key_hex))
    return err(400, 'Invalid public_key_hex: expected hex string of at least 64 characters');

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );

  const now = new Date().toISOString();

  const { error } = await db.from('devices').upsert({
    device_hash:     device_id,
    phone_hash:      auth.payload.phone_hash || auth.payload.sub,
    public_key_hex,
    key_algorithm,
    last_sync:       now,
    registered_at:   now,
    status:          'ACTIVE',
  }, { onConflict: 'device_hash', ignoreDuplicates: false });

  if (error) return err(500, `Device registration failed: ${error.message}`);

  console.log(`[register-device] ✅ Device ${device_id.slice(0,16)}... registered`);

  return ok({
    success:       true,
    device_id,
    registered_at: now,
    message:       'Device public key registered. Offline coin verification now available.',
  });
};
