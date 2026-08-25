/**
 * zillion/backend/netlify/functions/admin-coop-ecosystem-finance.js
 *
 * GET /api/v1/admin-coop-ecosystem-finance
 *
 * Ecosystem-wide view across every coop society: total subscription
 * revenue collected, a per-society breakdown, and an approximate MRR
 * figure. MRR is built from real recorded payments (each active
 * society's most recent successful payment, normalized to a monthly
 * equivalent by its billing cycle) rather than re-deriving what
 * "should" be owed from current pricing — actual collected revenue
 * is the more honest number for a revenue dashboard, and it's
 * naturally correct even if a society's pricing has since changed.
 *
 * Auth: SUPER_ADMIN or OPERATIONS.
 */
'use strict';

const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ['SUPER_ADMIN', 'OPERATIONS'])) return err(403, 'SUPER_ADMIN or OPERATIONS required');

  const db = getServiceClient();

  const { data: societies } = await db.from('coop_societies')
    .select('coop_id, name, subscription_plan, subscription_cycle, subscription_status, status');
  const { data: payments } = await db.from('coop_subscription_payments')
    .select('coop_id, amount_kobo, type, status, paid_at').eq('status', 'success').order('paid_at', { ascending: false });

  const paymentsByCoop = new Map();
  for (const p of (payments || [])) {
    if (!paymentsByCoop.has(p.coop_id)) paymentsByCoop.set(p.coop_id, []);
    paymentsByCoop.get(p.coop_id).push(p);
  }

  let totalRevenueKobo = 0, initialRevenueKobo = 0, renewalRevenueKobo = 0, mrrKobo = 0;
  const perSociety = [];

  for (const s of (societies || [])) {
    const societyPayments = paymentsByCoop.get(s.coop_id) || [];
    const totalPaidKobo = societyPayments.reduce((sum, p) => sum + p.amount_kobo, 0);
    totalRevenueKobo += totalPaidKobo;
    for (const p of societyPayments) {
      if (p.type === 'initial') initialRevenueKobo += p.amount_kobo;
      if (p.type === 'renewal') renewalRevenueKobo += p.amount_kobo;
    }

    const mostRecentPayment = societyPayments[0]; // already ordered desc by paid_at
    if (s.subscription_status === 'active' && mostRecentPayment) {
      mrrKobo += s.subscription_cycle === 'yearly' ? Math.round(mostRecentPayment.amount_kobo / 12) : mostRecentPayment.amount_kobo;
    }

    perSociety.push({
      coop_id: s.coop_id, name: s.name, plan: s.subscription_plan, cycle: s.subscription_cycle,
      subscription_status: s.subscription_status, operational_status: s.status,
      total_paid_kobo: totalPaidKobo, payment_count: societyPayments.length,
      last_payment_at: mostRecentPayment?.paid_at || null,
    });
  }

  perSociety.sort((a, b) => b.total_paid_kobo - a.total_paid_kobo);

  return ok({
    aggregate: {
      total_revenue_kobo: totalRevenueKobo,
      initial_revenue_kobo: initialRevenueKobo,
      renewal_revenue_kobo: renewalRevenueKobo,
      approximate_mrr_kobo: mrrKobo,
      total_societies: (societies || []).length,
      active_societies: (societies || []).filter(s => s.subscription_status === 'active').length,
      trial_societies: (societies || []).filter(s => s.subscription_status === 'trial').length,
    },
    societies: perSociety,
  });
};
