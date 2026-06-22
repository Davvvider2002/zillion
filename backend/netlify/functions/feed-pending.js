/**
 * GET /api/v1/feed/pending
 * Sprint 3: Bank polls for undelivered Zillion offline transactions.
 * Returns transactions that have settled in Zillion but not yet confirmed by the bank CBS.
 * Auth: Bank API key
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyBankAuth }   = require('../../lib/bank-auth');
const { createHmac }       = require('crypto');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b    => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m)=> ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyBankAuth(event);
  if (!auth.valid) return err(401, auth.reason);

  const db     = getServiceClient();
  const limit  = Math.min(parseInt(event.queryStringParameters?.limit  || '100'), 500);
  const cursor = event.queryStringParameters?.after_id || null;

  // Fetch undelivered feed items, oldest first (FIFO for the bank)
  let query = db.from('bank_feed_queue')
    .select('*')
    .eq('delivered', false)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (cursor) query = query.gt('id', cursor);

  const { data: items, error } = await query;
  if (error) return err(500, `Feed query failed: ${error.message}`);

  const transactions = (items || []).map(item => ({
    idempotency_key:   item.idempotency_key,
    event_type:        item.event_type,
    zillion_tx_id:     item.zillion_tx_id,
    bank_ref_sender:   item.bank_ref_sender,
    bank_ref_receiver: item.bank_ref_receiver,
    amount_kobo:       item.amount_kobo,
    amount_naira:      item.amount_kobo / 100,
    offline_ts:        item.offline_ts,
    settled_ts:        item.settled_ts,
    coin_ids:          item.coin_ids || [],
    agent_id:          item.agent_id,
    source:            item.source || 'ZILLION_OFFLINE',
    fraud_score:       item.fraud_score || 0.0,
    sync_lag_seconds:  item.offline_ts && item.settled_ts
      ? Math.round((new Date(item.settled_ts) - new Date(item.offline_ts)) / 1000)
      : null,
    feed_id:           item.id,
  }));

  return ok({
    success:      true,
    count:        transactions.length,
    has_more:     transactions.length === limit,
    transactions,
    queried_at:   new Date().toISOString(),
  });
};
