/**
 * zillion/backend/netlify/functions/admin-ajo-agents.js
 *
 * GET  /api/v1/admin-ajo-agents
 * POST /api/v1/admin-ajo-agents   { action: 'approve'|'suspend', agent_id }
 *      /api/v1/admin-ajo-agents   { action: 'create', zillion_id, referral_code, payout_bank_name?, payout_account_number? }
 *
 * The Zillion Ajo Admin agent-management function from the standalone
 * proposal (Part 1.3). An agent record is created here by the admin
 * (not self-service by the agent), then approved before their
 * referral_code becomes usable for attribution - onboarding is a
 * deliberate admin action, not automatic signup, since a referral
 * code determines who earns commission on real money movement.
 *
 * Each listed agent includes its live earnings summary: total
 * accrued, total paid out, outstanding balance, and how many of its
 * referral attributions are still within their 24-month commission
 * window versus already past it (Part 5.3 of the proposal) - capped,
 * not the scheme itself expiring, just the agent's commission on it.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { auditLog } = require('../../lib/auditLog');
const { checkParentEligible } = require('../../lib/ajoAgentHierarchy');

const ALLOWED_ROLES = ['SUPER_ADMIN', 'OPERATIONS'];
const COMMISSION_WINDOW_MONTHS = 24;

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ALLOWED_ROLES)) return err(403, 'Admin access required');

  const db = getServiceClient();

  if (event.httpMethod === 'GET') {
    const { data: agents } = await db.from('ajo_agents').select('*').order('created_at', { ascending: false });

    const withEarnings = await Promise.all((agents || []).map(async (a) => {
      const { data: earnings } = await db.from('ajo_agent_earnings').select('commission_kobo, paid_out_at, tier').eq('agent_id', a.id);
      const { data: attributions } = await db.from('ajo_referral_attributions')
        .select('id, attributed_at, ajo_schemes(id, name, status)').eq('agent_id', a.id);

      const totalAccruedKobo = (earnings || []).reduce((s, e) => s + e.commission_kobo, 0);
      const totalPaidKobo = (earnings || []).filter(e => e.paid_out_at).reduce((s, e) => s + e.commission_kobo, 0);
      // Tier 2 = overrides earned from sub-agents this agent recruited — broken out separately so an agent
      // who is themselves a parent can see how much of their total came from their own referrals vs their
      // downline's activity.
      const tier1AccruedKobo = (earnings || []).filter(e => e.tier === 1).reduce((s, e) => s + e.commission_kobo, 0);
      const tier2AccruedKobo = (earnings || []).filter(e => e.tier === 2).reduce((s, e) => s + e.commission_kobo, 0);
      const now = Date.now();
      const referredGroups = (attributions || []).map(at => {
        const cutoff = new Date(at.attributed_at).getTime() + COMMISSION_WINDOW_MONTHS * 30 * 24 * 3600 * 1000;
        return {
          scheme_id: at.ajo_schemes?.id || null,
          scheme_name: at.ajo_schemes?.name || '(deleted group)',
          scheme_status: at.ajo_schemes?.status || null,
          attributed_at: at.attributed_at,
          within_commission_window: now < cutoff,
        };
      });
      const withinWindow = referredGroups.filter(g => g.within_commission_window).length;

      return {
        ...a,
        referred_groups: referredGroups,
        total_referrals: referredGroups.length,
        referrals_within_commission_window: withinWindow,
        referrals_past_commission_window: referredGroups.length - withinWindow,
        total_accrued_kobo: totalAccruedKobo,
        total_paid_kobo: totalPaidKobo,
        outstanding_kobo: totalAccruedKobo - totalPaidKobo,
        tier1_accrued_kobo: tier1AccruedKobo,
        tier2_override_accrued_kobo: tier2AccruedKobo,
      };
    }));

    // Sub-agent count per parent — shown alongside each parent so the admin can see their downline size
    // without a second round trip.
    const subAgentCounts = new Map();
    for (const a of agents || []) if (a.parent_agent_id) subAgentCounts.set(a.parent_agent_id, (subAgentCounts.get(a.parent_agent_id) || 0) + 1);
    const withHierarchy = withEarnings.map(a => ({ ...a, sub_agent_count: subAgentCounts.get(a.id) || 0 }));

    return ok({ agents: withHierarchy });
  }

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const adminId = auth.payload.username || auth.payload.sub || 'unknown';

  if (body.action === 'create') {
    const zillionId = (body.zillion_id || '').trim();
    const referralCode = (body.referral_code || '').trim();
    if (!zillionId) return err(400, 'zillion_id is required');
    if (!referralCode) return err(400, 'referral_code is required');

    const insertRow = {
      zillion_id: zillionId, referral_code: referralCode,
      payout_bank_name: body.payout_bank_name || null, payout_account_number: body.payout_account_number || null,
      status: 'ACTIVE', approved_by: adminId, approved_at: new Date().toISOString(),
    };
    if (body.commission_rate_bps != null) {
      const rateBps = Number(body.commission_rate_bps);
      if (!Number.isInteger(rateBps) || rateBps <= 0 || rateBps > 10000) return err(400, 'commission_rate_bps must be a whole number between 1 and 10000 (basis points)');
      insertRow.commission_rate_bps = rateBps;
    } // omitted entirely -> the column's own default (3000, 30%) applies

    if (body.parent_agent_id) {
      const parentCheck = await checkParentEligible(db, body.parent_agent_id);
      if (parentCheck.error) return err(400, parentCheck.error);
      insertRow.parent_agent_id = body.parent_agent_id;
      if (body.tier2_override_bps != null) {
        const overrideBps = Number(body.tier2_override_bps);
        if (!Number.isInteger(overrideBps) || overrideBps <= 0 || overrideBps > 10000) return err(400, 'tier2_override_bps must be a whole number between 1 and 10000 (basis points)');
        insertRow.tier2_override_bps = overrideBps;
      } // omitted -> ajoCommission.js's own default (1000, 10%) applies at commission time
    }

    const { data: created, error } = await db.from('ajo_agents').insert(insertRow).select().single();

    if (error) return err(error.code === '23505' ? 409 : 500, error.code === '23505' ? 'That zillion_id or referral_code is already an agent' : `Failed to create agent: ${error.message}`);

    await auditLog(db, {
      action: 'ADMIN_AJO_AGENT_CREATED', username: adminId, role: auth.payload.role,
      ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
      resourceType: 'ajo_agents', resourceId: created.id, requestBody: body, result: 'SUCCESS',
    });

    return ok({ success: true, agent: created });
  }

  if (body.action === 'suspend' || body.action === 'approve') {
    const agentId = body.agent_id;
    if (!agentId) return err(400, 'agent_id is required');

    const newStatus = body.action === 'suspend' ? 'SUSPENDED' : 'ACTIVE';
    const { data: updated, error } = await db.from('ajo_agents').update({ status: newStatus }).eq('id', agentId).select().single();
    if (error) return err(500, `Failed to update agent: ${error.message}`);

    await auditLog(db, {
      action: `ADMIN_AJO_AGENT_${newStatus}`, username: adminId, role: auth.payload.role,
      ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
      resourceType: 'ajo_agents', resourceId: agentId, requestBody: body, result: 'SUCCESS',
    });

    return ok({ success: true, agent: updated });
  }

  if (body.action === 'record_payout') {
    const agentId = body.agentId || body.agent_id;
    if (!agentId) return err(400, 'agent_id is required');

    // Marks every currently-unpaid earning row as paid in one go,
    // matching how this actually happens in practice - an admin sends
    // one bank transfer covering the full outstanding balance, not a
    // separate transfer per referral commission line. Returns the
    // total so the admin can confirm what they just marked matches
    // what they actually paid, before the two figures have any chance
    // to drift apart.
    const { data: unpaidRows } = await db.from('ajo_agent_earnings')
      .select('id, commission_kobo').eq('agent_id', agentId).is('paid_out_at', null);

    if (!unpaidRows || !unpaidRows.length) return err(400, 'This agent has no outstanding balance to pay out');

    const totalKobo = unpaidRows.reduce((s, r) => s + r.commission_kobo, 0);
    const paidAt = new Date().toISOString();

    const { error } = await db.from('ajo_agent_earnings')
      .update({ paid_out_at: paidAt, paid_out_by: adminId }).eq('agent_id', agentId).is('paid_out_at', null);
    if (error) return err(500, `Failed to record payout: ${error.message}`);

    await auditLog(db, {
      action: 'ADMIN_AJO_AGENT_PAYOUT_RECORDED', username: adminId, role: auth.payload.role,
      ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
      resourceType: 'ajo_agents', resourceId: agentId, requestBody: body, result: 'SUCCESS',
    });

    return ok({ success: true, agent_id: agentId, rows_marked_paid: unpaidRows.length, total_kobo: totalKobo, paid_out_at: paidAt });
  }

  if (body.action === 'update_rate') {
    const agentId = body.agentId || body.agent_id;
    const rateBps = Number(body.commission_rate_bps);
    if (!agentId) return err(400, 'agent_id is required');
    if (!Number.isInteger(rateBps) || rateBps <= 0 || rateBps > 10000) return err(400, 'commission_rate_bps must be a whole number between 1 and 10000 (basis points)');

    // Deliberately affects only commission credited from this point
    // forward - ajo_agent_earnings rows already written keep whatever
    // rate was in effect when they were actually earned, since a rate
    // change today has no bearing on what a referral already paid out
    // under the old rate.
    const { data: updated, error } = await db.from('ajo_agents').update({ commission_rate_bps: rateBps }).eq('id', agentId).select().single();
    if (error) return err(500, `Failed to update commission rate: ${error.message}`);

    await auditLog(db, {
      action: 'ADMIN_AJO_AGENT_RATE_UPDATED', username: adminId, role: auth.payload.role,
      ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
      resourceType: 'ajo_agents', resourceId: agentId, requestBody: body, result: 'SUCCESS',
    });

    return ok({ success: true, agent: updated });
  }

  if (body.action === 'set_hierarchy') {
    const agentId = body.agentId || body.agent_id;
    if (!agentId) return err(400, 'agent_id is required');

    const { data: existing } = await db.from('ajo_agents').select('id').eq('id', agentId).maybeSingle();
    if (!existing) return err(404, 'Agent not found');

    const update = {};
    if (body.parent_agent_id === null) {
      // Explicit null clears the parent — this agent becomes (or stays) a top-level agent, no override
      // credited to anyone above them from this point forward. Existing tier-2 earnings rows already
      // credited are untouched — history, not something a hierarchy change should silently rewrite.
      update.parent_agent_id = null;
      update.tier2_override_bps = null;
    } else if (body.parent_agent_id) {
      const parentCheck = await checkParentEligible(db, body.parent_agent_id, agentId);
      if (parentCheck.error) return err(400, parentCheck.error);
      update.parent_agent_id = body.parent_agent_id;
      if (body.tier2_override_bps != null) {
        const overrideBps = Number(body.tier2_override_bps);
        if (!Number.isInteger(overrideBps) || overrideBps <= 0 || overrideBps > 10000) return err(400, 'tier2_override_bps must be a whole number between 1 and 10000 (basis points)');
        update.tier2_override_bps = overrideBps;
      }
    } else {
      return err(400, 'set_hierarchy requires parent_agent_id (a valid agent id, or null to clear)');
    }

    const { data: updated, error } = await db.from('ajo_agents').update(update).eq('id', agentId).select().single();
    if (error) return err(500, `Failed to update hierarchy: ${error.message}`);

    await auditLog(db, {
      action: 'ADMIN_AJO_AGENT_HIERARCHY_UPDATED', username: adminId, role: auth.payload.role,
      ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
      resourceType: 'ajo_agents', resourceId: agentId, requestBody: body, result: 'SUCCESS',
    });

    return ok({ success: true, agent: updated });
  }

  return err(400, "action must be 'create', 'approve', 'suspend', 'record_payout', 'update_rate', or 'set_hierarchy'");
};
