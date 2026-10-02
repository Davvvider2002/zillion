/**
 * zillion/backend/netlify/functions/coop-agent-engagement-report.js
 *
 * GET  /api/v1/coop-agent-engagement-report?prospect_id=...   -> every report logged for one prospect
 * POST /api/v1/coop-agent-engagement-report                   -> log a new one
 *
 * One row per meeting/demo with a cooperative society - the digital version of the Channel Partner Demo &
 * Cooperative Engagement Report. Submitting a report also updates the parent prospect's own lead_status and
 * estimated_onboarding_timeline to match (Section 10 describes the prospect's CURRENT state, not just this
 * one meeting's - so the pipeline list always reflects the most recent read on where things stand, without
 * needing to look up each prospect's latest report separately).
 *
 * Every checklist/multi-select field from the original form (features demonstrated, pain points, objections,
 * commercial interest, add-ons, next actions, people present, feature requests) is accepted as a plain array
 * of strings (or objects, for feature_requests and people_present) rather than a fixed enum - Zillion's own
 * product team may want to add or reword checklist items over time without a schema migration every time, and
 * the aggregate analysis (admin-coop-agent-pipeline.js) already reads these as arrays regardless of exactly
 * what's in them.
 *
 * Does NOT handle file attachments (the original form's Section 14) - that needs its own storage
 * infrastructure not yet set up for this surface.
 *
 * Auth: wallet JWT (zillion_id) - only the agent who owns a prospect can log a report against it.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { fetchAllRows } = require('../../lib/coopPaginate');

const LEAD_STATUSES = ['HOT','WARM','QUALIFIED','NURTURE','NOT_INTERESTED'];

function toArray(v) { return Array.isArray(v) ? v : []; }

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  const zillionId = auth.payload.zillion_id;
  if (!zillionId) return err(400, 'No zillion_id on this token — sign in through the wallet first');

  const db = getServiceClient();
  const { data: agent } = await db.from('coop_agents').select('id, status').eq('zillion_id', zillionId).maybeSingle();
  if (!agent) return err(404, 'No agent profile found for this account.');

  if (event.httpMethod === 'GET') {
    const qs = event.queryStringParameters || {};
    const prospectId = (qs.prospect_id || '').trim();
    if (!prospectId) return err(400, 'prospect_id is required');

    const { data: prospect } = await db.from('coop_agent_prospects').select('id, agent_id').eq('id', prospectId).maybeSingle();
    if (!prospect) return err(404, 'Prospect not found');
    if (prospect.agent_id !== agent.id) return err(403, 'This prospect does not belong to you.');

    const reports = await fetchAllRows(() => db.from('coop_agent_engagement_reports').select('*').eq('prospect_id', prospectId).order('engagement_date', { ascending: false }).order('id'));
    return ok({ reports });
  }

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');
  if (agent.status !== 'ACTIVE') return err(403, 'Your agent account is not currently active.');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const prospectId = (body.prospect_id || '').trim();
  const engagementDate = (body.engagement_date || '').trim();
  const leadStatus = (body.lead_status || '').trim().toUpperCase();

  if (!prospectId) return err(400, 'prospect_id is required');
  if (!engagementDate) return err(400, 'engagement_date is required');
  if (!LEAD_STATUSES.includes(leadStatus)) return err(400, `lead_status must be one of: ${LEAD_STATUSES.join(', ')}`);

  const { data: prospect } = await db.from('coop_agent_prospects').select('id, agent_id').eq('id', prospectId).maybeSingle();
  if (!prospect) return err(404, 'Prospect not found');
  if (prospect.agent_id !== agent.id) return err(403, 'This prospect does not belong to you.');

  const clampRating = v => (Number.isInteger(v) && v >= 1 && v <= 5) ? v : null;

  const insertRow = {
    prospect_id: prospectId, agent_id: agent.id,
    engagement_date: engagementDate,
    start_time: (body.start_time || '').trim() || null,
    meeting_type: body.meeting_type || null,
    location_or_platform: (body.location_or_platform || '').trim() || null,
    engagement_type: body.engagement_type || null,
    duration_band: body.duration_band || null,

    people_present: toArray(body.people_present),
    key_decision_maker_name: (body.key_decision_maker_name || '').trim() || null,
    key_decision_maker_position: (body.key_decision_maker_position || '').trim() || null,
    key_decision_maker_contact: (body.key_decision_maker_contact || '').trim() || null,

    features_demonstrated: toArray(body.features_demonstrated),

    overall_reaction: body.overall_reaction || null,
    top_attractions: toArray(body.top_attractions).slice(0, 3),
    most_impressive_feature: (body.most_impressive_feature || '').trim() || null,

    pain_points: toArray(body.pain_points),
    biggest_problem_description: (body.biggest_problem_description || '').trim() || null,

    feature_requests: toArray(body.feature_requests),
    customisation_category: (body.customisation_category || '').trim() || null,
    customisation_explanation: (body.customisation_explanation || '').trim() || null,
    customisation_essential: body.customisation_essential || null,

    questions_asked: toArray(body.questions_asked),
    objections: toArray(body.objections),
    objection_details: (body.objection_details || '').trim() || null,
    objection_resolution: (body.objection_resolution || '').trim() || null,
    needs_further_response: !!body.needs_further_response,
    required_response: (body.required_response || '').trim() || null,

    current_members_estimate: Number.isInteger(body.current_members_estimate) ? body.current_members_estimate : null,
    potential_members_estimate: Number.isInteger(body.potential_members_estimate) ? body.potential_members_estimate : null,
    commercial_interest: toArray(body.commercial_interest),
    pricing_discussed: !!body.pricing_discussed,
    plan_discussed: (body.plan_discussed || '').trim() || null,
    quoted_amount_kobo: Number.isInteger(body.quoted_amount_kobo) ? body.quoted_amount_kobo : null,
    addons_of_interest: toArray(body.addons_of_interest),

    lead_status: leadStatus,
    estimated_onboarding_timeline: (body.estimated_onboarding_timeline || '').trim() || null,

    next_actions: toArray(body.next_actions),
    next_meeting_date: (body.next_meeting_date || '').trim() || null,
    responsible_person: (body.responsible_person || '').trim() || null,
    expected_outcome: (body.expected_outcome || '').trim() || null,

    rating_customer_interest: clampRating(body.rating_customer_interest),
    rating_product_fit: clampRating(body.rating_product_fit),
    rating_commercial_potential: clampRating(body.rating_commercial_potential),
    rating_decision_maker_engagement: clampRating(body.rating_decision_maker_engagement),
    rating_likelihood_onboarding: clampRating(body.rating_likelihood_onboarding),
    biggest_opportunity: (body.biggest_opportunity || '').trim() || null,
    adoption_blockers: (body.adoption_blockers || '').trim() || null,

    would_recommend: body.would_recommend || null,
    summary: (body.summary || '').trim() || null,
  };

  const { data: created, error } = await db.from('coop_agent_engagement_reports').insert(insertRow).select().single();
  if (error) return err(500, `Failed to save report: ${error.message}`);

  // The prospect's own record mirrors this report's status/timeline - so the pipeline list reflects the most
  // recent read without a join into history on every load.
  await db.from('coop_agent_prospects').update({
    lead_status: leadStatus,
    estimated_onboarding_timeline: insertRow.estimated_onboarding_timeline,
    updated_at: new Date().toISOString(),
  }).eq('id', prospectId);

  return ok({ success: true, report: created });
};
