/**
 * zillion/backend/netlify/functions/admin-coop-agents.js
 *
 * GET  /api/v1/admin-coop-agents
 * POST /api/v1/admin-coop-agents  { action: 'approve'|'suspend', agent_id }
 *      /api/v1/admin-coop-agents  { action: 'create', zillion_id, name, payout_bank_name?, payout_account_number?, commission_rate_bps?, parent_agent_id?, tier2_override_bps? }
 *      /api/v1/admin-coop-agents  { action: 'record_payout', agent_id }
 *      /api/v1/admin-coop-agents  { action: 'update_rate', agent_id, commission_rate_bps }
 *      /api/v1/admin-coop-agents  { action: 'set_hierarchy', agent_id, parent_agent_id | null, tier2_override_bps? }
 *
 * An agent recruits cooperative societies onto the Coop SaaS subscription and earns a share of the fee
 * revenue those societies' subscription payments generate — this is a Coop concept, not Ajo (collectors are
 * the Ajo-side field role for cash collection; the two are deliberately separate people, separate tables,
 * separate parts of the admin panel).
 *
 * An agent record is created here by the admin (not self-service by the agent), then approved before their
 * referral_code becomes usable for attribution — onboarding is a deliberate admin action, not automatic
 * signup, since a referral code determines who earns commission on real subscription revenue. The code
 * itself is never typed in — generateReferralCode() (coopAgentHierarchy.js) derives it from name, following
 * the same PREFIX-NAME## template the platform's own agents already use.
 *
 * Each listed agent includes its live earnings summary: total accrued, total paid out, outstanding balance,
 * and how many of its referral attributions are still within their 24-month commission window versus already
 * past it — capped, not the society's own subscription expiring, just the agent's commission on it.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { auditLog } = require('../../lib/auditLog');
const { checkParentEligible, generateReferralCode } = require('../../lib/coopAgentHierarchy');

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
    const { data: agents } = await db.from('coop_agents').select('*').order('created_at', { ascending: false });

    const withEarnings = await Promise.all((agents || []).map(async (a) => {
      const { data: earnings } = await db.from('coop_agent_earnings').select('commission_kobo, paid_out_at, tier').eq('agent_id', a.id);
      const { data: attributions } = await db.from('coop_referral_attributions')
        .select('id, attributed_at, coop_societies(coop_id, name, status)').eq('agent_id', a.id);

      const totalAccruedKobo = (earnings || []).reduce((s, e) => s + e.commission_kobo, 0);
      const totalPaidKobo = (earnings || []).filter(e => e.paid_out_at).reduce((s, e) => s + e.commission_kobo, 0);
      const tier1AccruedKobo = (earnings || []).filter(e => e.tier === 1).reduce((s, e) => s + e.commission_kobo, 0);
      const tier2AccruedKobo = (earnings || []).filter(e => e.tier === 2).reduce((s, e) => s + e.commission_kobo, 0);
      const now = Date.now();
      const referredSocieties = (attributions || []).map(at => {
        const cutoff = new Date(at.attributed_at).getTime() + COMMISSION_WINDOW_MONTHS * 30 * 24 * 3600 * 1000;
        return {
          coop_id: at.coop_societies?.coop_id || null,
          society_name: at.coop_societies?.name || '(deleted society)',
          society_status: at.coop_societies?.status || null,
          attributed_at: at.attributed_at,
          within_commission_window: now < cutoff,
        };
      });
      const withinWindow = referredSocieties.filter(g => g.within_commission_window).length;

      return {
        ...a,
        referred_societies: referredSocieties,
        total_referrals: referredSocieties.length,
        referrals_within_commission_window: withinWindow,
        referrals_past_commission_window: referredSocieties.length - withinWindow,
        total_accrued_kobo: totalAccruedKobo,
        total_paid_kobo: totalPaidKobo,
        outstanding_kobo: totalAccruedKobo - totalPaidKobo,
        tier1_accrued_kobo: tier1AccruedKobo,
        tier2_override_accrued_kobo: tier2AccruedKobo,
      };
    }));

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
    const name = (body.name || '').trim();
    if (!zillionId) return err(400, 'zillion_id is required');
    if (!name) return err(400, 'name is required (used to generate the referral code)');

    const referralCode = await generateReferralCode(db, name);

    const insertRow = {
      zillion_id: zillionId, name, referral_code: referralCode,
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
      } // omitted -> coopAgentCommission.js's own default (1000, 10%) applies at commission time
    }

    const { data: created, error } = await db.from('coop_agents').insert(insertRow).select().single();

    if (error) return err(error.code === '23505' ? 409 : 500, error.code === '23505' ? 'That zillion_id is already an agent' : `Failed to create agent: ${error.message}`);

    await auditLog(db, {
      action: 'ADMIN_COOP_AGENT_CREATED', username: adminId, role: auth.payload.role,
      ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
      resourceType: 'coop_agents', resourceId: created.id, requestBody: body, result: 'SUCCESS',
    });

    return ok({ success: true, agent: created });
  }

  if (body.action === 'suspend' || body.action === 'approve') {
    const agentId = body.agent_id;
    if (!agentId) return err(400, 'agent_id is required');

    const newStatus = body.action === 'suspend' ? 'SUSPENDED' : 'ACTIVE';
    const { data: updated, error } = await db.from('coop_agents').update({ status: newStatus }).eq('id', agentId).select().single();
    if (error) return err(500, `Failed to update agent: ${error.message}`);

    await auditLog(db, {
      action: `ADMIN_COOP_AGENT_${newStatus}`, username: adminId, role: auth.payload.role,
      ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
      resourceType: 'coop_agents', resourceId: agentId, requestBody: body, result: 'SUCCESS',
    });

    return ok({ success: true, agent: updated });
  }

  if (body.action === 'record_payout') {
    const agentId = body.agentId || body.agent_id;
    if (!agentId) return err(400, 'agent_id is required');

    const { data: unpaidRows } = await db.from('coop_agent_earnings')
      .select('id, commission_kobo').eq('agent_id', agentId).is('paid_out_at', null);

    if (!unpaidRows || !unpaidRows.length) return err(400, 'This agent has no outstanding balance to pay out');

    const totalKobo = unpaidRows.reduce((s, r) => s + r.commission_kobo, 0);
    const paidAt = new Date().toISOString();

    const { error } = await db.from('coop_agent_earnings')
      .update({ paid_out_at: paidAt, paid_out_by: adminId }).eq('agent_id', agentId).is('paid_out_at', null);
    if (error) return err(500, `Failed to record payout: ${error.message}`);

    await auditLog(db, {
      action: 'ADMIN_COOP_AGENT_PAYOUT_RECORDED', username: adminId, role: auth.payload.role,
      ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
      resourceType: 'coop_agents', resourceId: agentId, requestBody: body, result: 'SUCCESS',
    });

    return ok({ success: true, agent_id: agentId, rows_marked_paid: unpaidRows.length, total_kobo: totalKobo, paid_out_at: paidAt });
  }

  if (body.action === 'update_rate') {
    const agentId = body.agentId || body.agent_id;
    const rateBps = Number(body.commission_rate_bps);
    if (!agentId) return err(400, 'agent_id is required');
    if (!Number.isInteger(rateBps) || rateBps <= 0 || rateBps > 10000) return err(400, 'commission_rate_bps must be a whole number between 1 and 10000 (basis points)');

    const { data: updated, error } = await db.from('coop_agents').update({ commission_rate_bps: rateBps }).eq('id', agentId).select().single();
    if (error) return err(500, `Failed to update commission rate: ${error.message}`);

    await auditLog(db, {
      action: 'ADMIN_COOP_AGENT_RATE_UPDATED', username: adminId, role: auth.payload.role,
      ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
      resourceType: 'coop_agents', resourceId: agentId, requestBody: body, result: 'SUCCESS',
    });

    return ok({ success: true, agent: updated });
  }

  if (body.action === 'set_hierarchy') {
    const agentId = body.agentId || body.agent_id;
    if (!agentId) return err(400, 'agent_id is required');

    const { data: existing } = await db.from('coop_agents').select('id').eq('id', agentId).maybeSingle();
    if (!existing) return err(404, 'Agent not found');

    const update = {};
    if (body.parent_agent_id === null) {
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

    const { data: updated, error } = await db.from('coop_agents').update(update).eq('id', agentId).select().single();
    if (error) return err(500, `Failed to update hierarchy: ${error.message}`);

    await auditLog(db, {
      action: 'ADMIN_COOP_AGENT_HIERARCHY_UPDATED', username: adminId, role: auth.payload.role,
      ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
      resourceType: 'coop_agents', resourceId: agentId, requestBody: body, result: 'SUCCESS',
    });

    return ok({ success: true, agent: updated });
  }

  return err(400, "action must be 'create', 'approve', 'suspend', 'record_payout', 'update_rate', or 'set_hierarchy'");
};
