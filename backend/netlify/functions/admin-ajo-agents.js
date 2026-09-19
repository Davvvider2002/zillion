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
      const { data: earnings } = await db.from('ajo_agent_earnings').select('commission_kobo, paid_out_at').eq('agent_id', a.id);
      const { data: attributions } = await db.from('ajo_referral_attributions')
        .select('id, attributed_at, ajo_schemes(id, name, status)').eq('agent_id', a.id);

      const totalAccruedKobo = (earnings || []).reduce((s, e) => s + e.commission_kobo, 0);
      const totalPaidKobo = (earnings || []).filter(e => e.paid_out_at).reduce((s, e) => s + e.commission_kobo, 0);
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
      };
    }));

    return ok({ agents: withEarnings });
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

    const { data: created, error } = await db.from('ajo_agents').insert({
      zillion_id: zillionId, referral_code: referralCode,
      payout_bank_name: body.payout_bank_name || null, payout_account_number: body.payout_account_number || null,
      status: 'ACTIVE', approved_by: adminId, approved_at: new Date().toISOString(),
    }).select().single();

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

  return err(400, "action must be 'create', 'approve', or 'suspend'");
};
