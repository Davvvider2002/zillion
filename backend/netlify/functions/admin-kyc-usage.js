/**
 * zillion/backend/netlify/functions/admin-kyc-usage.js
 *
 * GET /api/v1/admin-kyc-usage[?coop_id=X]
 *
 * Platform-wide (or one society's) NIN-verification usage: invoice status across societies, and the margin
 * between what Zillion pays Dojah and what societies are charged, over the last 90 days.
 */
'use strict';

const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { fetchAllRows, chunk } = require('../../lib/coopPaginate');

const ADMIN_ROLES = ['SUPER_ADMIN', 'COMPLIANCE', 'OPERATIONS', 'SUPPORT', 'AUDITOR', 'VIEWER'];

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ADMIN_ROLES)) return err(403, 'Admin access required.');

  const db = getServiceClient();
  const coopId = (event.queryStringParameters || {}).coop_id || null;

  try {
    let invoiceQuery = () => db.from('coop_kyc_invoices').select('id, coop_id, period_start, period_end, verification_count, total_kobo, status, due_at, paid_at').order('period_start', { ascending: false }).order('id');
    if (coopId) { const base = invoiceQuery; invoiceQuery = () => base().eq('coop_id', coopId); }
    const invoices = await fetchAllRows(invoiceQuery);

    const coopIds = [...new Set(invoices.map(i => i.coop_id))];
    const nameOf = {};
    for (const part of chunk(coopIds)) {
      const rows = await fetchAllRows(() => db.from('coop_societies').select('coop_id, name').in('coop_id', part).order('coop_id'));
      for (const s of rows) nameOf[s.coop_id] = s.name;
    }
    const invoicesOut = invoices.map(i => ({ ...i, society_name: nameOf[i.coop_id] || i.coop_id }));

    const since90 = new Date(Date.now() - 90 * 86400000).toISOString();
    let verifQuery = () => db.from('coop_kyc_verifications').select('matched, dojah_cost_kobo, charged_kobo').gte('created_at', since90).order('id');
    if (coopId) { const base = verifQuery; verifQuery = () => base().eq('coop_id', coopId); }
    const recentVerifications = await fetchAllRows(verifQuery);

    const totals = recentVerifications.reduce((acc, v) => {
      acc.count++; acc.matched += v.matched ? 1 : 0;
      acc.dojahCostKobo += v.dojah_cost_kobo || 0; acc.chargedKobo += v.charged_kobo || 0;
      return acc;
    }, { count: 0, matched: 0, dojahCostKobo: 0, chargedKobo: 0 });

    return ok({
      success: true, invoices: invoicesOut,
      last_90_days: { ...totals, margin_kobo: totals.chargedKobo - totals.dojahCostKobo },
    });
  } catch (e) {
    console.error('[admin-kyc-usage]', e);
    return err(500, 'Could not load KYC usage.');
  }
};
