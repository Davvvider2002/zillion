/**
 * zillion/backend/netlify/functions/coop-agent-my-dashboard.js
 *
 * GET /api/v1/coop-agent-my-dashboard
 *
 * An agent's own self-service view of everything about their own work: their profile and commission rate
 * (both set by Zillion Admin, read-only here), every cooperative society they've referred with that
 * society's live subscription status (so the agent can see at a glance which clients are paid up, on trial,
 * or lapsed), their own earnings (accrued/paid/outstanding, tier-1 vs tier-2 broken out), and — if they're a
 * parent in the two-tier hierarchy — the sub-agents reporting to them.
 *
 * Auth: wallet JWT (zillion_id) - the same sign-in every agent already has, not a separate admin login.
 * Resolves the caller's own coop_agents row by zillion_id; there is no way to view another agent's data
 * through this endpoint.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

const COMMISSION_WINDOW_MONTHS = 24;

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  const zillionId = auth.payload.zillion_id;
  if (!zillionId) return err(400, 'No zillion_id on this token — sign in through the wallet first');

  const db = getServiceClient();

  const { data: agent } = await db.from('coop_agents').select('*').eq('zillion_id', zillionId).maybeSingle();
  if (!agent) return err(404, 'No agent profile found for this account. If you applied recently, wait for Zillion Admin to approve your application.');

  const [{ data: earnings }, { data: attributions }, { data: subAgents }] = await Promise.all([
    db.from('coop_agent_earnings').select('commission_kobo, paid_out_at, tier, downline_agent_id').eq('agent_id', agent.id),
    db.from('coop_referral_attributions').select('id, attributed_at, coop_societies(coop_id, name, status, subscription_status, subscription_plan, subscription_paid_until, trial_ends_at, never_expires)').eq('agent_id', agent.id),
    db.from('coop_agents').select('id, name, referral_code, status').eq('parent_agent_id', agent.id),
  ]);

  const totalAccruedKobo = (earnings || []).reduce((s, e) => s + e.commission_kobo, 0);
  const totalPaidKobo = (earnings || []).filter(e => e.paid_out_at).reduce((s, e) => s + e.commission_kobo, 0);
  const tier1AccruedKobo = (earnings || []).filter(e => e.tier === 1).reduce((s, e) => s + e.commission_kobo, 0);
  const tier2AccruedKobo = (earnings || []).filter(e => e.tier === 2).reduce((s, e) => s + e.commission_kobo, 0);

  const now = Date.now();
  const clients = (attributions || []).map(at => {
    const cutoff = new Date(at.attributed_at).getTime() + COMMISSION_WINDOW_MONTHS * 30 * 24 * 3600 * 1000;
    const s = at.coop_societies || {};
    return {
      coop_id: s.coop_id || null,
      name: s.name || '(deleted society)',
      status: s.status || null,
      subscription_status: s.subscription_status || null,
      subscription_plan: s.subscription_plan || null,
      subscription_paid_until: s.subscription_paid_until || null,
      trial_ends_at: s.trial_ends_at || null,
      never_expires: !!s.never_expires,
      referred_at: at.attributed_at,
      within_commission_window: now < cutoff,
    };
  });

  // If this agent has a parent, surface who — commission overrides flow to them, worth the agent knowing.
  let parent = null;
  if (agent.parent_agent_id) {
    const { data: p } = await db.from('coop_agents').select('name, referral_code').eq('id', agent.parent_agent_id).maybeSingle();
    parent = p || null;
  }

  return ok({
    agent: {
      name: agent.name, referral_code: agent.referral_code, status: agent.status,
      commission_rate_bps: agent.commission_rate_bps, tier2_override_bps: agent.tier2_override_bps,
      parent,
    },
    earnings: {
      total_accrued_kobo: totalAccruedKobo, total_paid_kobo: totalPaidKobo, outstanding_kobo: totalAccruedKobo - totalPaidKobo,
      tier1_accrued_kobo: tier1AccruedKobo, tier2_override_accrued_kobo: tier2AccruedKobo,
    },
    clients,
    sub_agents: subAgents || [],
  });
};
