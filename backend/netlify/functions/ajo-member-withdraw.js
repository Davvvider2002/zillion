/**
 * zillion/backend/netlify/functions/ajo-member-withdraw.js
 *
 * POST /api/v1/ajo-member-withdraw
 * Body: { scheme_id, amount_kobo }
 *
 * "Breaking the piggy bank" - on-demand withdrawal for personal
 * savings only. Only valid for scheme_type = 'personal_savings';
 * a rotational/thrift group member cannot just cash out on request -
 * their money is part of a collective pool waiting for the rotation,
 * which is the entire point of that scheme type. This endpoint
 * explicitly rejects any other scheme_type rather than silently
 * doing the wrong thing.
 *
 * Available balance = everything this member has ever contributed to
 * this scheme, minus everything they've already withdrawn - reuses
 * ajo_payouts rather than a new table, since a withdrawal is
 * structurally identical to a payout: money leaving the pool to a
 * specific member, just requested by the member instead of decided
 * by a rotation. Same fee engine and agent commission logic as a
 * normal payout (Part 4.1 / Part 5.2 of the standalone proposal).
 *
 * A personal savings scheme's single, ever-open cycle (created at
 * scheme creation, never closed by ajo-admin-process-cycle.js, which
 * explicitly refuses this scheme_type) is where every contribution
 * and every withdrawal attaches.
 *
 * Auth: wallet JWT (zillion_id) - must be this scheme's own (sole) member.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { resolveFeeRate, computeFeeKobo } = require('../../lib/ajoFeeEngine');
const { creditAgentCommissionIfApplicable } = require('../../lib/ajoCommission');

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
  const requestedKobo = Number.isInteger(body.amount_kobo) && body.amount_kobo > 0 ? body.amount_kobo : null;
  if (!schemeId) return err(400, 'scheme_id is required');
  if (!requestedKobo) return err(400, 'amount_kobo must be a positive integer');

  const db = getServiceClient();

  const { data: scheme } = await db.from('ajo_schemes').select('id, scheme_type, status').eq('id', schemeId).maybeSingle();
  if (!scheme) return err(404, 'Scheme not found');
  if (scheme.scheme_type !== 'personal_savings') return err(400, 'Withdrawals are only available for personal savings — this is a group scheme, where money is part of a collective rotation, not yours alone to withdraw on request.');
  if (scheme.status !== 'ACTIVE') return err(400, `This savings pot is ${scheme.status.toLowerCase()}`);

  const { data: membership } = await db.from('ajo_scheme_members').select('id, status').eq('scheme_id', schemeId).eq('zillion_id', zillionId).maybeSingle();
  if (!membership || membership.status !== 'ACTIVE') return err(403, 'You are not the owner of this savings pot');

  const { data: cycle } = await db.from('ajo_cycles').select('id, started_at').eq('scheme_id', schemeId).eq('status', 'OPEN').order('cycle_number', { ascending: false }).limit(1).maybeSingle();
  if (!cycle) return err(400, 'This savings pot has no open period to withdraw from');

  const { data: contributions } = await db.from('ajo_contributions').select('amount_kobo').eq('scheme_member_id', membership.id).eq('status', 'PAID');
  const totalContributedKobo = (contributions || []).reduce((s, c) => s + c.amount_kobo, 0);

  const { data: priorWithdrawals } = await db.from('ajo_payouts').select('amount_kobo, fee_kobo').eq('scheme_member_id', membership.id).eq('status', 'DISBURSED');
  const totalWithdrawnKobo = (priorWithdrawals || []).reduce((s, p) => s + p.amount_kobo + (p.fee_kobo || 0), 0);

  const availableKobo = Math.max(0, totalContributedKobo - totalWithdrawnKobo);
  if (requestedKobo > availableKobo) return err(400, `You can withdraw up to ${(availableKobo / 100).toFixed(2)} — that's your full available balance.`);

  const feeRate = await resolveFeeRate(db, 'payout', cycle.started_at);
  const feeKobo = computeFeeKobo(feeRate, requestedKobo);
  const netWithdrawalKobo = Math.max(0, requestedKobo - feeKobo);

  const { data: withdrawal, error: withdrawErr } = await db.from('ajo_payouts').insert({
    cycle_id: cycle.id, scheme_member_id: membership.id, amount_kobo: netWithdrawalKobo, fee_kobo: feeKobo,
    status: 'DISBURSED', disbursed_at: new Date().toISOString(),
  }).select().single();
  if (withdrawErr) return err(500, `Failed to record withdrawal: ${withdrawErr.message}`);

  await db.from('ajo_ledger').insert({ scheme_id: schemeId, entry_type: 'payout', amount_kobo: netWithdrawalKobo, reference_id: withdrawal.id });

  const agentCommissionKobo = feeKobo > 0 ? await creditAgentCommissionIfApplicable(db, schemeId, feeKobo, 'payout', withdrawal.id) : 0;

  return ok({
    success: true, withdrawal, fee_kobo: feeKobo, agent_commission_kobo: agentCommissionKobo,
    remaining_balance_kobo: availableKobo - requestedKobo,
  });
};
