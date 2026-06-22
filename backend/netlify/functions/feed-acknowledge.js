/**
 * POST /api/v1/feed/acknowledge
 * Sprint 3: Bank confirms it has processed feed items into its CBS.
 * Marks items as delivered so they don't appear in future /feed/pending calls.
 * Idempotent — acknowledging the same key twice is safe.
 * Auth: Bank API key
 * Body: { idempotency_keys: string[] }
 */
'use strict';

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

  const { idempotency_keys } = body;
  if (!Array.isArray(idempotency_keys) || idempotency_keys.length === 0)
    return err(400, 'idempotency_keys must be a non-empty array');
  if (idempotency_keys.length > 500)
    return err(400, 'Maximum 500 keys per acknowledgement');

  const db  = getServiceClient();
  const now = new Date().toISOString();

  const { data: updated, error } = await db.from('bank_feed_queue')
    .update({ delivered: true, delivered_at: now, retry_count: 0 })
    .in('idempotency_key', idempotency_keys)
    .select('idempotency_key');

  if (error) return err(500, `Acknowledgement failed: ${error.message}`);

  console.log(`[feed-ack] ${auth.bank_id} acknowledged ${updated?.length || 0} transactions`);

  return ok({
    success:      true,
    acknowledged: updated?.length || 0,
    bank_id:      auth.bank_id,
    acknowledged_at: now,
  });
};
