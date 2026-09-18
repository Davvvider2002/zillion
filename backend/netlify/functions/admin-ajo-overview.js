/**
 * zillion/backend/netlify/functions/admin-ajo-overview.js
 *
 * GET /api/v1/admin-ajo-overview
 *
 * The Zillion Ajo Admin platform oversight dashboard from the
 * standalone proposal (Part 1.3): every group, every member,
 * contribution volume, fee revenue collected, and outstanding agent
 * commission liability - platform-wide, not scoped to any one group,
 * which is exactly what a group admin's own dashboard (ajo-admin/)
 * can never show.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');

const ALLOWED_ROLES = ['SUPER_ADMIN', 'OPERATIONS'];

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ALLOWED_ROLES)) return err(403, 'Admin access required');

  const db = getServiceClient();

  const [
    { count: totalSchemes },
    { count: activeSchemes },
    { count: totalMembers },
    { data: contributions },
    { data: payouts },
    { count: totalAgents },
    { data: unpaidEarnings },
  ] = await Promise.all([
    db.from('ajo_schemes').select('id', { count: 'exact', head: true }),
    db.from('ajo_schemes').select('id', { count: 'exact', head: true }).eq('status', 'ACTIVE'),
    db.from('ajo_scheme_members').select('id', { count: 'exact', head: true }).eq('status', 'ACTIVE'),
    db.from('ajo_contributions').select('amount_kobo, fee_kobo'),
    db.from('ajo_payouts').select('amount_kobo, fee_kobo').eq('status', 'DISBURSED'),
    db.from('ajo_agents').select('id', { count: 'exact', head: true }).eq('status', 'ACTIVE'),
    db.from('ajo_agent_earnings').select('commission_kobo').is('paid_out_at', null),
  ]);

  const contributionVolumeKobo = (contributions || []).reduce((s, c) => s + c.amount_kobo, 0);
  const contributionFeeRevenueKobo = (contributions || []).reduce((s, c) => s + (c.fee_kobo || 0), 0);
  const payoutVolumeKobo = (payouts || []).reduce((s, p) => s + p.amount_kobo, 0);
  const payoutFeeRevenueKobo = (payouts || []).reduce((s, p) => s + (p.fee_kobo || 0), 0);
  const outstandingAgentCommissionKobo = (unpaidEarnings || []).reduce((s, e) => s + e.commission_kobo, 0);

  const { data: schemesByType } = await db.from('ajo_schemes').select('scheme_type');
  const typeBreakdown = (schemesByType || []).reduce((acc, s) => {
    acc[s.scheme_type] = (acc[s.scheme_type] || 0) + 1;
    return acc;
  }, {});

  return ok({
    total_schemes: totalSchemes || 0,
    active_schemes: activeSchemes || 0,
    total_active_members: totalMembers || 0,
    contribution_volume_kobo: contributionVolumeKobo,
    payout_volume_kobo: payoutVolumeKobo,
    total_fee_revenue_kobo: contributionFeeRevenueKobo + payoutFeeRevenueKobo,
    active_agents: totalAgents || 0,
    outstanding_agent_commission_kobo: outstandingAgentCommissionKobo,
    schemes_by_type: typeBreakdown,
  });
};
