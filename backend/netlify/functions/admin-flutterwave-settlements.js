/**
 * zillion/backend/netlify/functions/admin-flutterwave-settlements.js
 *
 * GET /api/v1/admin-flutterwave-settlements
 *
 * Pulls real settlement batches from Flutterwave (GET /v3/settlements
 * — each settlement's `meta` field lists the transaction IDs it
 * covers) and cross-references them against every subscription
 * payment recorded as successful in coop_subscription_payments. A
 * payment landing in a real settlement is genuinely confirmed money
 * in Zillion's account, not just a successful verify() call.
 *
 * A payment not yet appearing in any settlement is usually just
 * normal settlement delay (Flutterwave settles on its own schedule,
 * not instantly) — flagged as a real discrepancy only once it's
 * been unsettled for more than 5 days.
 *
 * Auth: SUPER_ADMIN or OPERATIONS.
 */
'use strict';

const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');

const STALE_UNSETTLED_DAYS = 5;

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ['SUPER_ADMIN', 'OPERATIONS'])) return err(403, 'SUPER_ADMIN or OPERATIONS required');

  const secretKey = (process.env.FLW_V3_SECRET_KEY || '').trim();
  if (!secretKey) return err(500, 'FLW_V3_SECRET_KEY not configured');

  const db = getServiceClient();

  let settlements = [];
  try {
    const res = await fetch('https://api.flutterwave.com/v3/settlements', {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    const data = await res.json();
    if (data.status !== 'success') return err(502, `Flutterwave rejected the settlements request: ${data.message || 'unknown error'}`);
    settlements = data.data || [];
  } catch (e) {
    return err(502, `Failed to reach Flutterwave: ${e.message}`);
  }

  // Each settlement's transaction IDs come back as a JSON-encoded
  // string, not a real array — parse defensively since a malformed
  // one shouldn't break the whole reconciliation.
  const settledTransactionIds = new Set();
  const settlementSummaries = settlements.map(s => {
    let txIds = [];
    try { txIds = JSON.parse(s.meta || '[]'); } catch (e) { /* leave empty */ }
    txIds.forEach(id => settledTransactionIds.add(String(id)));
    return {
      id: s.id, status: s.status, processed_date: s.processed_date, currency: s.currency,
      gross_amount: s.gross_amount, app_fee: s.app_fee, net_amount: s.net_amount, transaction_count: s.transaction_count,
    };
  });

  const { data: successfulPayments } = await db.from('coop_subscription_payments')
    .select('coop_id, amount_kobo, flw_transaction_id, type, paid_at, coop_societies(name)')
    .eq('status', 'success').order('paid_at', { ascending: false });

  const now = new Date();
  let settledCount = 0, unsettledCount = 0;
  const staleUnsettled = [];

  for (const p of (successfulPayments || [])) {
    const isSettled = settledTransactionIds.has(String(p.flw_transaction_id));
    if (isSettled) { settledCount++; continue; }
    unsettledCount++;
    const daysSince = (now - new Date(p.paid_at)) / 86400000;
    if (daysSince > STALE_UNSETTLED_DAYS) {
      staleUnsettled.push({
        coop_id: p.coop_id, society_name: p.coop_societies?.name, amount_kobo: p.amount_kobo,
        flw_transaction_id: p.flw_transaction_id, type: p.type, paid_at: p.paid_at, days_unsettled: Math.floor(daysSince),
      });
    }
  }

  return ok({
    settlements: settlementSummaries,
    reconciliation: {
      total_successful_payments: (successfulPayments || []).length,
      settled_count: settledCount,
      unsettled_count: unsettledCount,
      stale_unsettled: staleUnsettled, // genuinely worth investigating — settled for longer than expected
    },
  });
};
