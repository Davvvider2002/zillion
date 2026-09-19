/**
 * zillion/backend/netlify/functions/ajo-member-record-contribution.js
 *
 * POST /api/v1/ajo-member-record-contribution
 *
 * Records one contribution against the caller's own membership in a
 * scheme's current OPEN cycle. This is the endpoint where the fee
 * engine (ajoFeeEngine.js) and the agent commission system actually
 * activate - everything built so far (fee configuration, agent
 * referral attribution) exists to feed this one moment.
 *
 * Flow:
 *  1. Resolve the caller's ACTIVE membership in the scheme.
 *  2. Find the scheme's current OPEN cycle - contributions only ever
 *     attach to a real, open cycle, never float unattached.
 *  3. Resolve the contribution fee rate effective as of THAT cycle's
 *     own started_at (never "today's" rate - Part 4.1).
 *  4. Insert the contribution, append to ajo_ledger (contribution
 *     entry_type), and if the scheme has a referral attribution
 *     still within its 24-month commission window, credit the
 *     agent's earnings for exactly the fee just collected - not the
 *     full contribution amount, since the fee IS the platform's
 *     revenue and commission is a share of revenue, not of members'
 *     own savings.
 *
 * Body: { scheme_id, amount_kobo?, source? }
 *   amount_kobo defaults to the scheme's own contribution_amount_kobo
 *   if omitted - the normal case. A caller can override it upward or
 *   downward (e.g. a documented partial payment), never below zero.
 * Auth: wallet JWT (zillion_id).
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
  if (!schemeId) return err(400, 'scheme_id is required');

  const db = getServiceClient();

  const { data: scheme } = await db.from('ajo_schemes').select('id, contribution_amount_kobo, status').eq('id', schemeId).maybeSingle();
  if (!scheme) return err(404, 'Scheme not found');

  const { data: membership } = await db.from('ajo_scheme_members').select('id, status').eq('scheme_id', schemeId).eq('zillion_id', zillionId).maybeSingle();
  if (!membership || membership.status !== 'ACTIVE') return err(403, 'You are not an active member of this scheme');

  const { data: cycle } = await db.from('ajo_cycles').select('id, started_at').eq('scheme_id', schemeId).eq('status', 'OPEN').order('cycle_number', { ascending: false }).limit(1).maybeSingle();
  if (!cycle) return err(400, 'This scheme has no open cycle to contribute to right now');

  const amountKobo = Number.isInteger(body.amount_kobo) && body.amount_kobo > 0 ? body.amount_kobo : scheme.contribution_amount_kobo;
  const source = body.source === 'cash' ? 'cash' : 'digital';

  const feeRate = await resolveFeeRate(db, 'contribution', cycle.started_at);
  const feeKobo = computeFeeKobo(feeRate, amountKobo);

  const { data: contribution, error: contribErr } = await db.from('ajo_contributions').insert({
    cycle_id: cycle.id, scheme_member_id: membership.id, amount_kobo: amountKobo, fee_kobo: feeKobo,
    status: 'PAID', source,
  }).select().single();
  if (contribErr) return err(500, `Failed to record contribution: ${contribErr.message}`);

  await db.from('ajo_ledger').insert({
    scheme_id: schemeId, entry_type: 'contribution', amount_kobo: amountKobo, reference_id: contribution.id,
  });

  let agentCommissionKobo = 0;
  if (feeKobo > 0) {
    agentCommissionKobo = await creditAgentCommissionIfApplicable(db, schemeId, feeKobo, 'contribution', contribution.id);
  }

  return ok({
    success: true, contribution, fee_kobo: feeKobo,
    agent_commission_kobo: agentCommissionKobo,
  });
};
