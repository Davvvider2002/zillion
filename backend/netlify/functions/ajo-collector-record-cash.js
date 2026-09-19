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
const { creditContribution } = require('../../lib/ajoCreditContribution');

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

  const amountKobo = Number.isInteger(body.amount_kobo) && body.amount_kobo > 0 ? body.amount_kobo : scheme.contribution_amount_kobo;

  const result = await creditContribution(db, {
    schemeId, schemeMemberId: membership.id, amountKobo, source: 'cash', recordedBy: collectorZillionId,
  });
  if (!result.ok) return err(400, result.error);

  return ok({ success: true, contribution: result.contribution, fee_kobo: result.feeKobo, agent_commission_kobo: result.agentCommissionKobo });
};
