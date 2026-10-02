/**
 * zillion/backend/netlify/functions/admin-coop-agent-pipeline.js
 *
 * GET  /api/v1/admin-coop-agent-pipeline
 * POST /api/v1/admin-coop-agent-pipeline  { action: 'classify', prospect_id, lead_grade?, assigned_account_manager?,
 *   technical_review_required?, customisation_review_required?, management_escalation_required?, internal_comments? }
 *
 * Zillion Admin's view over every agent's prospect pipeline — the analysis half of the Channel Partner CRM
 * workflow (agents log engagement reports from coop-agent-engagement-report.js; this is where that rolls up).
 *
 * GET returns: per-agent performance KPIs (meetings logged, prospects qualified, hot leads, members
 * represented, pending follow-ups — the same shape as the original form's "Channel Partner Performance"
 * table), the platform-wide lead grade distribution, the most commonly requested features/pain points across
 * every report ever logged (aggregate product-intelligence, not just one meeting's notes), and the list of
 * prospects whose next_meeting_date has arrived or passed with nothing logged since — the actual "who needs
 * following up" list, not just a KPI count of one.
 *
 * POST 'classify' is the only write here — lead_grade, account manager assignment, and the three internal
 * review flags (Section 13 of the original form) are Zillion-Admin-only; an agent's own coop-agent-prospects.js
 * can read these back but never set them.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { auditLog } = require('../../lib/auditLog');
const { fetchAllRows, chunk } = require('../../lib/coopPaginate');

const ALLOWED_ROLES = ['SUPER_ADMIN', 'OPERATIONS'];
const LEAD_GRADES = ['A', 'B', 'C', 'D'];

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ALLOWED_ROLES)) return err(403, 'Admin access required');

  const db = getServiceClient();

  if (event.httpMethod === 'GET') {
    const prospects = await fetchAllRows(() => db.from('coop_agent_prospects').select('*').order('updated_at', { ascending: false }).order('id'));
    const agentIds = [...new Set(prospects.map(p => p.agent_id))];
    let agentsById = {};
    for (const part of chunk(agentIds)) {
      for (const a of await fetchAllRows(() => db.from('coop_agents').select('id, name, referral_code').in('id', part).order('id'))) agentsById[a.id] = a;
    }

    const prospectIds = prospects.map(p => p.id);
    let allReports = [];
    for (const part of chunk(prospectIds)) {
      allReports.push(...await fetchAllRows(() => db.from('coop_agent_engagement_reports').select('*').in('prospect_id', part).order('id')));
    }

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const reportsThisMonth = allReports.filter(r => new Date(r.engagement_date) >= startOfMonth);

    // Per-agent performance, same shape as the form's own "Channel Partner Performance" table.
    const perAgent = {};
    for (const p of prospects) {
      if (!perAgent[p.agent_id]) {
        perAgent[p.agent_id] = {
          agent_id: p.agent_id, agent_name: agentsById[p.agent_id]?.name || 'Unknown', referral_code: agentsById[p.agent_id]?.referral_code || null,
          prospects_total: 0, qualified: 0, hot: 0, onboarded: 0, members_represented: 0, customisation_requests: 0, meetings_this_month: 0, pending_followups: 0,
        };
      }
      const row = perAgent[p.agent_id];
      row.prospects_total++;
      if (p.lead_status === 'QUALIFIED') row.qualified++;
      if (p.lead_status === 'HOT') row.hot++;
      if (p.converted_to_coop_id) row.onboarded++;
      row.members_represented += p.estimated_active_members || 0;
      if (p.next_meeting_date && p.next_meeting_date <= now.toISOString().slice(0, 10)) row.pending_followups++;
    }
    for (const r of reportsThisMonth) {
      if (perAgent[r.agent_id]) perAgent[r.agent_id].meetings_this_month++;
    }
    for (const r of allReports) {
      if (perAgent[r.agent_id] && (r.feature_requests || []).length) perAgent[r.agent_id].customisation_requests += r.feature_requests.length;
    }

    // Lead grade distribution, platform-wide.
    const gradeDistribution = { A: 0, B: 0, C: 0, D: 0, UNGRADED: 0 };
    for (const p of prospects) gradeDistribution[p.lead_grade || 'UNGRADED']++;

    // Top requested features and pain points across every report ever logged - real product intelligence, not
    // just one meeting's notes.
    const featureCounts = {}, painPointCounts = {};
    for (const r of allReports) {
      for (const fr of (r.feature_requests || [])) {
        const key = (fr.feature || fr).toString().trim();
        if (key) featureCounts[key] = (featureCounts[key] || 0) + 1;
      }
      for (const pp of (r.pain_points || [])) {
        const key = pp.toString().trim();
        if (key) painPointCounts[key] = (painPointCounts[key] || 0) + 1;
      }
    }
    const topFeatureRequests = Object.entries(featureCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([feature, count]) => ({ feature, count }));
    const topPainPoints = Object.entries(painPointCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([pain_point, count]) => ({ pain_point, count }));

    // Who actually needs following up - a real list, not just a count.
    const todayStr = now.toISOString().slice(0, 10);
    const needsFollowUp = prospects
      .filter(p => p.next_meeting_date && p.next_meeting_date <= todayStr && !p.converted_to_coop_id && p.lead_status !== 'NOT_INTERESTED')
      .map(p => ({ prospect_id: p.id, cooperative_name: p.cooperative_name, agent_name: agentsById[p.agent_id]?.name || 'Unknown', lead_status: p.lead_status, next_meeting_date: p.next_meeting_date }));

    return ok({
      summary: {
        total_prospects: prospects.length,
        total_agents_with_prospects: agentIds.length,
        total_meetings_this_month: reportsThisMonth.length,
        total_onboarded: prospects.filter(p => p.converted_to_coop_id).length,
        total_members_represented: prospects.reduce((s, p) => s + (p.estimated_active_members || 0), 0),
      },
      per_agent: Object.values(perAgent).sort((a, b) => b.prospects_total - a.prospects_total),
      lead_grade_distribution: gradeDistribution,
      top_feature_requests: topFeatureRequests,
      top_pain_points: topPainPoints,
      needs_follow_up: needsFollowUp,
      prospects,
    });
  }

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  if (body.action !== 'classify') return err(400, "action must be 'classify'");

  const prospectId = (body.prospect_id || '').trim();
  if (!prospectId) return err(400, 'prospect_id is required');

  const { data: prospect } = await db.from('coop_agent_prospects').select('id').eq('id', prospectId).maybeSingle();
  if (!prospect) return err(404, 'Prospect not found');

  const update = { updated_at: new Date().toISOString() };
  if (body.lead_grade !== undefined) {
    if (body.lead_grade !== null && !LEAD_GRADES.includes(body.lead_grade)) return err(400, `lead_grade must be one of: ${LEAD_GRADES.join(', ')}`);
    update.lead_grade = body.lead_grade;
  }
  if (body.assigned_account_manager !== undefined) update.assigned_account_manager = (body.assigned_account_manager || '').trim() || null;
  if (body.technical_review_required !== undefined) update.technical_review_required = !!body.technical_review_required;
  if (body.customisation_review_required !== undefined) update.customisation_review_required = !!body.customisation_review_required;
  if (body.management_escalation_required !== undefined) update.management_escalation_required = !!body.management_escalation_required;
  if (body.internal_comments !== undefined) update.internal_comments = (body.internal_comments || '').trim() || null;

  const { data: updated, error } = await db.from('coop_agent_prospects').update(update).eq('id', prospectId).select().single();
  if (error) return err(500, `Failed to update: ${error.message}`);

  const adminActor = auth.payload.username || auth.payload.sub || 'unknown';
  await auditLog(db, {
    action: 'ADMIN_COOP_AGENT_PROSPECT_CLASSIFIED', username: adminActor, role: auth.payload.role,
    ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_agent_prospects', resourceId: prospectId, requestBody: body, result: 'SUCCESS',
  });

  return ok({ success: true, prospect: updated });
};
