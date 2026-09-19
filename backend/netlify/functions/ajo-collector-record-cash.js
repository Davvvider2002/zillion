/**
 * zillion/backend/netlify/functions/ajo-collector-record-cash.js
 *
 * POST /api/v1/ajo-collector-record-cash
 * Body: { scheme_id, member_zillion_id, amount_kobo? }
 *
 * A collector records a cash contribution on behalf of another
 * member - deliberately a separate endpoint from
 * ajo-member-record-contribution.js, which only ever lets someone
 * record a contribution for themselves. Recording on someone else's
 * behalf requires being a verified, ACTIVE collector for that exact
 * scheme; there is no general "record for anyone" capability.
 *
 * Same fee-engine logic as the digital contribution path (Part 4.1
 * of the standalone proposal) - the source is 'cash' instead of
 * 'digital' and recorded_by carries the collector's own zillion_id,
 * which is what ajo-collector-reconcile.js later sums up as
 * "expected" for that collector's end-of-day reconciliation.
 *
 * Auth: wallet JWT (zillion_id) - must be an ACTIVE collector for
 * this specific scheme.
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
  const collectorZillionId = auth.payload.zillion_id;
  if (!collectorZillionId) return err(400, 'No zillion_id on this token — sign in through the wallet first');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const schemeId = (body.scheme_id || '').trim();
  const memberZillionId = (body.member_zillion_id || '').trim();
  if (!schemeId) return err(400, 'scheme_id is required');
  if (!memberZillionId) return err(400, 'member_zillion_id is required');

  const db = getServiceClient();

  const { data: collector } = await db.from('ajo_collectors').select('id').eq('scheme_id', schemeId).eq('zillion_id', collectorZillionId).eq('status', 'ACTIVE').maybeSingle();
  if (!collector) return err(403, 'You are not an active collector for this scheme');

  const { data: scheme } = await db.from('ajo_schemes').select('id, contribution_amount_kobo, status').eq('id', schemeId).maybeSingle();
  if (!scheme) return err(404, 'Scheme not found');

  const { data: membership } = await db.from('ajo_scheme_members').select('id, status').eq('scheme_id', schemeId).eq('zillion_id', memberZillionId).maybeSingle();
  if (!membership || membership.status !== 'ACTIVE') return err(404, 'That person is not an active member of this scheme');

  const { data: cycle } = await db.from('ajo_cycles').select('id, started_at').eq('scheme_id', schemeId).eq('status', 'OPEN').order('cycle_number', { ascending: false }).limit(1).maybeSingle();
  if (!cycle) return err(400, 'This scheme has no open cycle to contribute to right now');

  const amountKobo = Number.isInteger(body.amount_kobo) && body.amount_kobo > 0 ? body.amount_kobo : scheme.contribution_amount_kobo;

  const feeRate = await resolveFeeRate(db, 'contribution', cycle.started_at);
  const feeKobo = computeFeeKobo(feeRate, amountKobo);

  const { data: contribution, error: contribErr } = await db.from('ajo_contributions').insert({
    cycle_id: cycle.id, scheme_member_id: membership.id, amount_kobo: amountKobo, fee_kobo: feeKobo,
    status: 'PAID', source: 'cash', recorded_by: collectorZillionId,
  }).select().single();
  if (contribErr) return err(500, `Failed to record contribution: ${contribErr.message}`);

  await db.from('ajo_ledger').insert({ scheme_id: schemeId, entry_type: 'contribution', amount_kobo: amountKobo, reference_id: contribution.id });

  let agentCommissionKobo = 0;
  if (feeKobo > 0) {
    agentCommissionKobo = await creditAgentCommissionIfApplicable(db, schemeId, feeKobo, 'contribution', contribution.id);
  }

  return ok({ success: true, contribution, fee_kobo: feeKobo, agent_commission_kobo: agentCommissionKobo });
};
