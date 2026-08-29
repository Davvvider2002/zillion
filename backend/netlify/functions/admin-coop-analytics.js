/**
 * zillion/backend/netlify/functions/admin-coop-analytics.js
 *
 * GET /api/v1/admin-coop-analytics
 *
 * Zillion-admin-only (not a single society's own portal, which has no
 * business seeing other societies' data) — aggregates across every
 * society: counts by industry, counts by member occupation, and loan
 * patterns (average size, repayment rate) broken down by occupation.
 *
 * This is deliberately the data-foundation layer, not a credit
 * scoring system itself — surfacing real patterns in the data so
 * that groundwork exists, not inventing a scoring formula that
 * hasn't been designed yet.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ['SUPER_ADMIN','COMPLIANCE','OPERATIONS','SUPPORT','AUDITOR','VIEWER']))
    return err(403, 'Admin access required');

  const db = getServiceClient();

  // Societies by industry
  const { data: societies } = await db.from('coop_societies').select('coop_id, primary_industry, status');
  const societiesByIndustry = {};
  for (const s of (societies || [])) {
    const key = s.primary_industry || 'Not specified';
    societiesByIndustry[key] = (societiesByIndustry[key] || 0) + 1;
  }

  // Members by occupation
  const { data: members } = await db.from('coop_members').select('id, occupation, status').eq('status', 'ACTIVE');
  const membersByOccupation = {};
  for (const m of (members || [])) {
    const key = m.occupation || 'Not specified';
    membersByOccupation[key] = (membersByOccupation[key] || 0) + 1;
  }

  // Loan patterns by occupation: join loans back to their member's
  // occupation, then aggregate. Only loans that reached disbursement
  // count toward "average size" (a rejected or pending application
  // isn't a real loan pattern yet); repayment rate uses completed +
  // disbursed/repaying loans to show what fraction have been paid off.
  const { data: loans } = await db.from('coop_loans')
    .select('member_id, principal_kobo, total_repayable_kobo, status, coop_members!coop_loans_member_id_fkey(occupation)')
    .in('status', ['DISBURSED', 'REPAYING', 'COMPLETED']);

  const loansByOccupation = {};
  for (const l of (loans || [])) {
    const key = l.coop_members?.occupation || 'Not specified';
    if (!loansByOccupation[key]) loansByOccupation[key] = { count: 0, totalPrincipalKobo: 0, completedCount: 0 };
    loansByOccupation[key].count += 1;
    loansByOccupation[key].totalPrincipalKobo += l.principal_kobo;
    if (l.status === 'COMPLETED') loansByOccupation[key].completedCount += 1;
  }
  const loanPatternsByOccupation = Object.entries(loansByOccupation).map(([occupation, d]) => ({
    occupation,
    loan_count: d.count,
    average_principal_kobo: Math.round(d.totalPrincipalKobo / d.count),
    completed_count: d.completedCount,
    completion_rate_percent: Math.round((d.completedCount / d.count) * 100),
  }));

  return ok({
    societies_by_industry: societiesByIndustry,
    members_by_occupation: membersByOccupation,
    loan_patterns_by_occupation: loanPatternsByOccupation,
    total_societies: (societies || []).length,
    total_active_members: (members || []).length,
  });
};
