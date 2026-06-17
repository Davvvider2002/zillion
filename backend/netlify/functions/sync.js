/**
 * zillion/backend/netlify/functions/sync.js
 *
 * POST /api/v1/sync
 * Device submits pending offline transactions for settlement.
 * Core double-spend detection happens here.
 *
 * Auth: Device JWT
 * Body: { device_id: string, tx_batch: Array<TxRecord> }
 */

'use strict';

const { processSyncBatch } = require('../../lib/supabase');
const { validateSyncBatch, verifyJWT } = require('../../lib/validators');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) {
    return { statusCode: 401, body: JSON.stringify({ error: auth.reason }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { valid, errors } = validateSyncBatch(body);
  if (!valid) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Validation failed', errors }) };
  }

  try {
    const { getServiceClient } = require('../../lib/supabase');
    const db = getServiceClient();

    // Register / update device record (makes user visible in admin Customers tab)
    const deviceId  = body.device_id || auth.payload.sub;
    const phoneHash = auth.payload.phone_hash || auth.payload.sub;
    // Register device — makes user visible in admin Customers tab.
    // public_key_hex is required by schema; we use a placeholder since the
    // real device key isn't transmitted in sync. A future /register endpoint
    // should update this with the actual Ed25519 public key.
    const now = new Date().toISOString();
    const { error: devErr } = await db.from('devices').upsert({
      device_hash:     deviceId,
      phone_hash:      phoneHash,
      public_key_hex:  'PENDING',   // placeholder — schema requires NOT NULL
      last_sync:       now,
      registered_at:   now,
      status:          'ACTIVE',
    }, { onConflict: 'device_hash', ignoreDuplicates: false });
    if (devErr) console.warn('Device upsert warn:', devErr.message);

    // Process transactions (may be empty heartbeat)
    const result = body.tx_batch && body.tx_batch.length
      ? await processSyncBatch(body.tx_batch)
      : { settled: [], conflicts: [] };

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success:          true,
        device_id:        body.device_id,
        settled_count:    result.settled.length,
        conflict_count:   result.conflicts.length,
        settled_coin_ids: result.settled,
        conflicts:        result.conflicts,
        sync_ts:          new Date().toISOString(),
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: `Sync failed: ${err.message}` }) };
  }
};
