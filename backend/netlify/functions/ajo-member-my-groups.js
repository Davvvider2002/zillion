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

// Converts cycle-based scheduling into approximate months for
// display - people think in duration terms, not cycle counts.
// Verified against 4 scenarios (mid-run, just started, final cycle,
// short daily scheme) before being wired in here.
function monthsPerCycle(frequency) {
  if (frequency === 'daily') return 1 / 30;
  if (frequency === 'weekly') return 1 / 4.345; // average weeks per month
  return 1; // monthly
}
function computeDurationMonths(frequency, cycleLength, currentCycleNumber) {
  const perCycle = monthsPerCycle(frequency);
  const totalMonths = cycleLength * perCycle;
  const elapsedCycles = Math.max(0, (currentCycleNumber || 1) - 1);
  const elapsedMonths = elapsedCycles * perCycle;
  const remainingCycles = Math.max(0, cycleLength - (currentCycleNumber || 1) + 1);
  const remainingMonths = remainingCycles * perCycle;
  return {
    total_duration_months: +totalMonths.toFixed(1),
    elapsed_months: +elapsedMonths.toFixed(1),
    remaining_months: +remainingMonths.toFixed(1),
  };
}

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
    .select('id, scheme_id, joined_at, cycle_position, dedicated_account_number, dedicated_account_bank, ajo_schemes(name, scheme_type, status, contribution_amount_kobo, frequency, cycle_length)')
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
      .select('amount_kobo, cycle_id, diverted_to_collector').eq('scheme_member_id', m.id).eq('status', 'PAID');

    // A diverted contribution (personal_savings' first-of-month
    // collector compensation) genuinely was never the saver's own
    // money to begin with - excluded here, not subtracted back out
    // after being counted, so the balance is honestly correct from
    // the start rather than looking inflated then corrected.
    const myOwnContributions = (myContributions || []).filter(c => !c.diverted_to_collector);
    const totalContributedKobo = myOwnContributions.reduce((s, c) => s + c.amount_kobo, 0);
    const requiredSoFarKobo = Math.max(1, cyclesSinceJoining) * contributionAmountKobo;
    const creditBalanceKobo = totalContributedKobo - requiredSoFarKobo;

    const { data: myWithdrawals } = await db.from('ajo_payouts')
      .select('amount_kobo, fee_kobo').eq('scheme_member_id', m.id).eq('status', 'DISBURSED');
    const totalWithdrawnKobo = (myWithdrawals || []).reduce((s, p) => s + p.amount_kobo + (p.fee_kobo || 0), 0);
    const availableBalanceKobo = Math.max(0, totalContributedKobo - totalWithdrawnKobo);

    const contributedThisCycleKobo = openCycle
      ? myOwnContributions.filter(c => c.cycle_id === openCycle.id).reduce((s, c) => s + c.amount_kobo, 0)
      : 0;

    const { count: activeMemberCount } = await db.from('ajo_scheme_members')
      .select('id', { count: 'exact', head: true }).eq('scheme_id', m.scheme_id).eq('status', 'ACTIVE');

    const duration = computeDurationMonths(scheme.frequency, scheme.cycle_length || 1, openCycle ? openCycle.cycle_number : 1);

    return {
      scheme_id: m.scheme_id,
      scheme_name: scheme.name || m.scheme_id,
      scheme_type: scheme.scheme_type || null,
      frequency: scheme.frequency || null,
      cycle_position: m.cycle_position,
      dedicated_account_number: m.dedicated_account_number || null,
      dedicated_account_bank: m.dedicated_account_bank || null,
      is_current: m.scheme_id === auth.payload.ajo_scheme_id,
      contribution_amount_kobo: contributionAmountKobo,
      open_cycle_number: openCycle ? openCycle.cycle_number : null,
      cycle_length: scheme.cycle_length || null,
      contributed_this_cycle_kobo: contributedThisCycleKobo,
      total_contributed_kobo: totalContributedKobo,
      credit_balance_kobo: creditBalanceKobo,
      total_withdrawn_kobo: totalWithdrawnKobo,
      available_balance_kobo: availableBalanceKobo,
      total_payout_per_round_kobo: (activeMemberCount || 0) * contributionAmountKobo,
      active_member_count: activeMemberCount || 0,
      ...duration,
    };
  }));

  return ok({ groups, has_multiple: groups.length > 1 });
};
