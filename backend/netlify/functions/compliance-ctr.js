/**
 * GET /api/v1/compliance/ctr
 * Sprint 3: CBN Currency Transaction Report data.
 * Returns all settled transactions >= ₦1,000,000 in the specified period.
 * CBN requirement: CTRs must be filed for single transactions >= ₦1,000,000.
 * Auth: Admin JWT
 * Query: ?from=2026-06-01&to=2026-06-30
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

const CTR_THRESHOLD_KOBO = 100_000_000; // ₦1,000,000

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b    => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m)=> ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid)                   return err(401, auth.reason);
  if (auth.payload.role !== 'admin') return err(403, 'Admin access required');

  const { from, to } = event.queryStringParameters || {};
  if (!from || !to) return err(400, 'Missing from and to query parameters (YYYY-MM-DD)');

  const fromDate = new Date(from + 'T00:00:00.000Z');
  const toDate   = new Date(to   + 'T23:59:59.999Z');
  if (isNaN(fromDate) || isNaN(toDate)) return err(400, 'Invalid date format — use YYYY-MM-DD');

  const db = getServiceClient();

  const { data: txns, error } = await db.from('transactions')
    .select('*')
    .eq('status', 'SETTLED')
    .gte('sync_ts', fromDate.toISOString())
    .lte('sync_ts', toDate.toISOString())
    .gte('amount', CTR_THRESHOLD_KOBO)
    .order('sync_ts', { ascending: false });

  if (error) return err(500, `CTR query failed: ${error.message}`);

  const transactions = (txns || []).map(t => ({
    transaction_id:   t.tx_id,
    amount_kobo:      t.amount,
    amount_naira:     t.amount / 100,
    from_hash:        t.from_hash,
    to_hash:          t.to_hash,
    coin_id:          t.coin_id,
    transaction_date: t.tx_ts,
    settlement_date:  t.sync_ts,
    agent_id:         t.agent_id || null,
    requires_ctr:     true,
  }));

  const totalKobo = transactions.reduce((s, t) => s + t.amount_kobo, 0);

  return ok({
    report_type:     'CURRENCY_TRANSACTION_REPORT',
    reporting_entity:'ZILLION',
    period_from:     from,
    period_to:       to,
    threshold_naira: CTR_THRESHOLD_KOBO / 100,
    transaction_count: transactions.length,
    total_kobo:      totalKobo,
    total_naira:     totalKobo / 100,
    transactions,
    generated_at:    new Date().toISOString(),
    note: 'Submit transactions above threshold to CBN via NFIU portal within 7 days.',
  });
};
