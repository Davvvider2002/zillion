/**
 * zillion/backend/netlify/functions/ajo-admin-process-cycle.js
 *
 * POST /api/v1/ajo-admin-process-cycle
 *
 * The last piece of the core Ajo loop: closes a scheme's current
 * OPEN cycle, selects who gets paid, disburses the payout (fee
 * engine + agent commission applied, exact mirror of how
 * ajo-member-record-contribution.js handles the contribution side),
 * and either opens the next cycle or marks the scheme COMPLETED if
 * this was the last one.
 *
 * A member can only ever receive one payout across a scheme's whole
 * run, not one per cycle - selectPayee() excludes anyone with an
 * existing DISBURSED payout for this scheme, checked fresh against
 * the database every time, not against a cached list. Verified
 * against 6 scenarios (sequential fixed-order selection, correct
 * exclusion of an already-paid member, refusing to pick anyone once
 * every member has been paid, rejecting an admin trying to re-pay
 * someone, accepting a valid admin choice, and refusing to guess when
 * admin_assigned/priority is used with no choice given) before this
 * was wired into any endpoint.
 *
 * Payout disbursement itself is recorded for tracking, not a real
 * bank transfer - actual money movement happens through the group's
 * own dedicated account outside this system (Part 1.1 of the
 * standalone proposal: non-custodial by design). This marks the
 * payout DISBURSED so the rotation can progress; it does not move
 * money.
 *
 * Only the scheme's own group admin (created_by_zillion_id) may call
 * this - a member, even the eventual payee, cannot close a cycle
 * themselves.
 *
 * Body: { scheme_id, payee_scheme_member_id? }
 *   payee_scheme_member_id is required for admin_assigned/priority
 *   payout order, ignored (and determined automatically) for
 *   fixed/random.
 * Auth: wallet JWT (zillion_id) - must match the scheme's own admin.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { resolveFeeRate, computeFeeKobo } = require('../../lib/ajoFeeEngine');
const { creditAgentCommissionIfApplicable } = require('../../lib/ajoCommission');

function selectPayee(members, alreadyPaidMemberIds, payoutOrder, adminChoiceId) {
  const eligible = members.filter(m => !alreadyPaidMemberIds.includes(m.id));
  if (eligible.length === 0) return { error: 'Every member has already received a payout — this scheme has completed its rotation.' };

  if (payoutOrder === 'admin_assigned' || payoutOrder === 'priority') {
    if (!adminChoiceId) return { error: 'This payout order requires you to specify who is paid this cycle (payee_scheme_member_id).' };
    const chosen = eligible.find(m => m.id === adminChoiceId);
    if (!chosen) return { error: 'That member is not eligible — either not an active member, or already paid.' };
    return { payee: chosen };
  }

  if (payoutOrder === 'random') {
    return { payee: eligible[Math.floor(Math.random() * eligible.length)] };
  }

  // fixed - lowest cycle_position among the still-eligible members
  const sorted = [...eligible].sort((a, b) => (a.cycle_position || 0) - (b.cycle_position || 0));
  return { payee: sorted[0] };
}

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  const zillionId = auth.payload.zillion_id;
  if (!zillionId) return err(400, 'No zillion_id on this token — sign in through the wallet first');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const schemeId = (body.scheme_id || '').trim();
  if (!schemeId) return err(400, 'scheme_id is required');

  const db = getServiceClient();

  const { data: scheme } = await db.from('ajo_schemes')
    .select('id, name, scheme_type, payout_order, cycle_length, created_by_zillion_id, status').eq('id', schemeId).maybeSingle();
  if (!scheme) return err(404, 'Scheme not found');
  if (scheme.scheme_type === 'personal_savings') return err(400, 'Personal savings has no rotation to process — use the withdraw action instead.');
  if (scheme.created_by_zillion_id !== zillionId) return err(403, 'Only this scheme\'s own group admin can process a cycle');
  if (scheme.status !== 'ACTIVE') return err(400, `This scheme is ${scheme.status.toLowerCase()} — no cycle to process`);

  const { data: cycle } = await db.from('ajo_cycles')
    .select('id, cycle_number, started_at').eq('scheme_id', schemeId).eq('status', 'OPEN')
    .order('cycle_number', { ascending: false }).limit(1).maybeSingle();
  if (!cycle) return err(400, 'This scheme has no open cycle right now');

  const { data: members } = await db.from('ajo_scheme_members')
    .select('id, cycle_position').eq('scheme_id', schemeId).eq('status', 'ACTIVE');
  if (!members || members.length === 0) return err(400, 'This scheme has no active members to pay');

  const { data: allCycles } = await db.from('ajo_cycles').select('id').eq('scheme_id', schemeId);
  const { data: paidPayouts } = await db.from('ajo_payouts')
    .select('scheme_member_id')
    .in('cycle_id', (allCycles || []).map(c => c.id))
    .eq('status', 'DISBURSED');
  const alreadyPaidIds = (paidPayouts || []).map(p => p.scheme_member_id);

  const selection = selectPayee(members, alreadyPaidIds, scheme.payout_order, body.payee_scheme_member_id || null);
  if (selection.error) return err(400, selection.error);
  const payee = selection.payee;

  // Payout amount = the sum of everything actually contributed into
  // this cycle - the real pool, not just the configured per-member
  // amount times member count, which would be wrong if anyone paid
  // partially or short.
  const { data: cycleContributions } = await db.from('ajo_contributions').select('amount_kobo').eq('cycle_id', cycle.id).eq('status', 'PAID');
  const poolKobo = (cycleContributions || []).reduce((s, c) => s + c.amount_kobo, 0);
  if (poolKobo <= 0) return err(400, 'No contributions have been recorded for this cycle yet — nothing to pay out.');

  const feeRate = await resolveFeeRate(db, 'payout', cycle.started_at);
  const feeKobo = computeFeeKobo(feeRate, poolKobo);
  const netPayoutKobo = Math.max(0, poolKobo - feeKobo);

  const { data: payout, error: payoutErr } = await db.from('ajo_payouts').insert({
    cycle_id: cycle.id, scheme_member_id: payee.id, amount_kobo: netPayoutKobo, fee_kobo: feeKobo,
    status: 'DISBURSED', disbursed_at: new Date().toISOString(),
  }).select().single();
  if (payoutErr) return err(500, `Failed to record payout: ${payoutErr.message}`);

  await db.from('ajo_ledger').insert({ scheme_id: schemeId, entry_type: 'payout', amount_kobo: netPayoutKobo, reference_id: payout.id });

  let agentCommissionKobo = 0;
  if (feeKobo > 0) {
    agentCommissionKobo = await creditAgentCommissionIfApplicable(db, schemeId, feeKobo, 'payout', payout.id);
  }

  await db.from('ajo_cycles').update({ status: 'PAID_OUT', closed_at: new Date().toISOString() }).eq('id', cycle.id);

  const remainingAfterThis = members.length - (alreadyPaidIds.length + 1);
  let nextCycle = null;
  let schemeCompleted = false;
  if (remainingAfterThis > 0 && cycle.cycle_number < scheme.cycle_length) {
    const { data: created } = await db.from('ajo_cycles').insert({
      scheme_id: schemeId, cycle_number: cycle.cycle_number + 1, status: 'OPEN',
    }).select().single();
    nextCycle = created || null;
  } else {
    await db.from('ajo_schemes').update({ status: 'COMPLETED' }).eq('id', schemeId);
    schemeCompleted = true;
  }

  return ok({
    success: true, payout, payee_scheme_member_id: payee.id,
    fee_kobo: feeKobo, agent_commission_kobo: agentCommissionKobo,
    next_cycle: nextCycle, scheme_completed: schemeCompleted,
  });
};
