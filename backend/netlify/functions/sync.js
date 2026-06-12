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
    const result = await processSyncBatch(body.tx_batch);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success:          true,
        device_id:        body.device_id,
        settled_count:    result.settled.length,
        conflict_count:   result.conflicts.length,
        settled_coin_ids: result.settled,
        conflicts:        result.conflicts,  // includes reason per conflict
        sync_ts:          new Date().toISOString(),
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: `Sync failed: ${err.message}` }) };
  }
};
