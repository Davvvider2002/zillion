/**
 * zillion/backend/netlify/functions/coop-agent-prospects.js
 *
 * GET  /api/v1/coop-agent-prospects
 * POST /api/v1/coop-agent-prospects  { cooperative_name, registration_number?, location?, state?,
 *   member_count_band?, estimated_active_members?, cooperative_type?, current_management_method?,
 *   current_software_name? }
 *
 * An agent's own pipeline of cooperative societies they're pursuing - the CRM this replaces the paper
 * "Channel Partner Demo & Cooperative Engagement Report" with. A prospect here is deliberately NOT a real
 * coop_societies row - most never convert, and the ones that do get linked via converted_to_coop_id once they
 * actually sign up (see coop-agent-engagement-report.js and wherever conversion is detected).
 *
 * Lead grading, account manager assignment, and internal review flags are Zillion-Admin-only (Section 13 of
 * the original form) - this endpoint never sets or returns an agent's ability to change them; GET includes
 * them read-only so an agent can see how their own pipeline was classified.
 *
 * Auth: wallet JWT (zillion_id) - resolves the caller's own coop_agents row, same as coop-agent-my-dashboard.js.
 * A prospect belongs to exactly the agent who created it; there's no way to see another agent's pipeline here.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { fetchAllRows } = require('../../lib/coopPaginate');

const MEMBER_BANDS = ['1-50','51-100','101-250','251-500','501-1000','1001-5000','5000+'];
const COOP_TYPES = ['THRIFT_CREDIT','MULTIPURPOSE','AGRICULTURAL','STAFF_EMPLOYEES','HOUSING','INVESTMENT','COMMUNITY_BASED','PROFESSIONAL_ASSOCIATION','OTHER'];
const MANAGEMENT_METHODS = ['MANUAL_PAPER','EXCEL_SPREADSHEET','WHATSAPP','EXISTING_COOP_SOFTWARE','ACCOUNTING_SOFTWARE','COMBINATION','OTHER'];

async function resolveAgent(db, zillionId) {
  const { data: agent } = await db.from('coop_agents').select('id, status').eq('zillion_id', zillionId).maybeSingle();
  return agent;
}

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  const zillionId = auth.payload.zillion_id;
  if (!zillionId) return err(400, 'No zillion_id on this token — sign in through the wallet first');

  const db = getServiceClient();
  const agent = await resolveAgent(db, zillionId);
  if (!agent) return err(404, 'No agent profile found for this account.');

  if (event.httpMethod === 'GET') {
    const prospects = await fetchAllRows(() => db.from('coop_agent_prospects').select('*').eq('agent_id', agent.id).order('updated_at', { ascending: false }).order('id'));
    const prospectIds = prospects.map(p => p.id);
    let reportCounts = {};
    if (prospectIds.length) {
      const reports = await fetchAllRows(() => db.from('coop_agent_engagement_reports').select('prospect_id, engagement_date').in('prospect_id', prospectIds).order('id'));
      for (const r of reports) {
        if (!reportCounts[r.prospect_id]) reportCounts[r.prospect_id] = { count: 0, last_engagement_date: null };
        reportCounts[r.prospect_id].count++;
        if (!reportCounts[r.prospect_id].last_engagement_date || r.engagement_date > reportCounts[r.prospect_id].last_engagement_date) {
          reportCounts[r.prospect_id].last_engagement_date = r.engagement_date;
        }
      }
    }

    return ok({ prospects: prospects.map(p => ({ ...p, engagement_count: reportCounts[p.id]?.count || 0, last_engagement_date: reportCounts[p.id]?.last_engagement_date || null })) });
  }

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');
  if (agent.status !== 'ACTIVE') return err(403, 'Your agent account is not currently active.');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const name = (body.cooperative_name || '').trim();
  if (!name) return err(400, 'cooperative_name is required');

  const memberBand = body.member_count_band && MEMBER_BANDS.includes(body.member_count_band) ? body.member_count_band : null;
  const coopType = body.cooperative_type && COOP_TYPES.includes(body.cooperative_type) ? body.cooperative_type : null;
  const mgmtMethod = body.current_management_method && MANAGEMENT_METHODS.includes(body.current_management_method) ? body.current_management_method : null;

  const { data: created, error } = await db.from('coop_agent_prospects').insert({
    agent_id: agent.id, cooperative_name: name,
    registration_number: (body.registration_number || '').trim() || null,
    location: (body.location || '').trim() || null,
    state: (body.state || '').trim() || null,
    member_count_band: memberBand,
    estimated_active_members: Number.isInteger(body.estimated_active_members) ? body.estimated_active_members : null,
    cooperative_type: coopType,
    current_management_method: mgmtMethod,
    current_software_name: (body.current_software_name || '').trim() || null,
  }).select().single();

  if (error) return err(500, `Failed to create prospect: ${error.message}`);

  return ok({ success: true, prospect: created });
};
