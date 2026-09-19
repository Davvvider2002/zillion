/**
 * zillion/backend/netlify/functions/ajo-member-my-groups.js
 *
 * GET /api/v1/ajo-member-my-groups
 *
 * Lists every ACTIVE ajo_scheme_members row for the caller's
 * zillion_id - mirrors coop-member-my-societies.js exactly, same
 * reasoning: a member genuinely active in more than one Ajo group
 * needs to see all of them and switch between, not silently default
 * to just one.
 *
 * Also returns the per-group stats the wallet's card UI and
 * Contribute modal need - the default contribution amount (set by
 * the group admin, not the member), current-cycle progress, total
 * contributed all-time, and a credit balance for anyone who has paid
 * ahead of schedule.
 *
 * Credit balance: required-so-far is (number of cycles that have
 * started since this member joined) x the scheme's contribution
 * amount - counting only cycles from their own join date forward, so
 * someone who joined mid-scheme isn't charged for cycles before they
 * were a member. total_contributed is everything they've ever paid
 * into this scheme. The difference is their credit: positive means
 * they've paid ahead (an "advance"), negative means they're behind.
 * This is informational, not enforced - nothing here blocks a member
 * who's behind from continuing to use the group.
 *
 * Auth: wallet JWT (the same token used everywhere else - no
 * separate Ajo login).
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  const zillionId = auth.payload.zillion_id;
  if (!zillionId) return ok({ groups: [] });

  const db = getServiceClient();
  const { data: memberships } = await db.from('ajo_scheme_members')
    .select('id, scheme_id, joined_at, cycle_position, ajo_schemes(name, scheme_type, status, contribution_amount_kobo, frequency, cycle_length)')
    .eq('zillion_id', zillionId)
    .eq('status', 'ACTIVE')
    .order('joined_at', { ascending: true });

  const groups = await Promise.all((memberships || []).map(async (m) => {
    const scheme = m.ajo_schemes || {};
    const contributionAmountKobo = scheme.contribution_amount_kobo || 0;

    const { data: cycles } = await db.from('ajo_cycles')
      .select('id, cycle_number, status, started_at').eq('scheme_id', m.scheme_id).order('cycle_number', { ascending: true });

    const openCycle = (cycles || []).find(c => c.status === 'OPEN') || null;
    const cyclesSinceJoining = (cycles || []).filter(c => new Date(c.started_at) >= new Date(m.joined_at)).length;

    const { data: myContributions } = await db.from('ajo_contributions')
      .select('amount_kobo, cycle_id').eq('scheme_member_id', m.id).eq('status', 'PAID');

    const totalContributedKobo = (myContributions || []).reduce((s, c) => s + c.amount_kobo, 0);
    const requiredSoFarKobo = Math.max(1, cyclesSinceJoining) * contributionAmountKobo;
    const creditBalanceKobo = totalContributedKobo - requiredSoFarKobo;

    const contributedThisCycleKobo = openCycle
      ? (myContributions || []).filter(c => c.cycle_id === openCycle.id).reduce((s, c) => s + c.amount_kobo, 0)
      : 0;

    return {
      scheme_id: m.scheme_id,
      scheme_name: scheme.name || m.scheme_id,
      scheme_type: scheme.scheme_type || null,
      frequency: scheme.frequency || null,
      cycle_position: m.cycle_position,
      is_current: m.scheme_id === auth.payload.ajo_scheme_id,
      contribution_amount_kobo: contributionAmountKobo,
      open_cycle_number: openCycle ? openCycle.cycle_number : null,
      contributed_this_cycle_kobo: contributedThisCycleKobo,
      total_contributed_kobo: totalContributedKobo,
      credit_balance_kobo: creditBalanceKobo,
    };
  }));

  return ok({ groups, has_multiple: groups.length > 1 });
};
