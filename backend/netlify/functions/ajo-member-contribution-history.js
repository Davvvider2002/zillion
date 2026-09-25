/**
 * zillion/backend/netlify/functions/ajo-member-contribution-history.js
 *
 * GET /api/v1/ajo-member-contribution-history?scheme_id=X
 *
 * A member's own itemized contribution history for one scheme - the
 * gap flagged when the personal_savings first-of-month collector
 * diversion was built: the summary balance was made honestly
 * correct (a diverted contribution never inflates it), but nothing
 * let a saver see the specific line explaining WHY one month's
 * payment didn't count. This is that line-item view.
 *
 * Each row includes diverted_to_collector directly, unrelabelled -
 * the frontend decides how to present it, but the fact itself comes
 * straight from the same column the balance calculation already
 * excludes on.
 *
 * Auth: wallet JWT - always the caller's own scheme_member_id for
 * this scheme, never another member's, and only for a scheme they
 * actually belong to.
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
  if (!zillionId) return err(400, 'No zillion_id on this token — sign in through the wallet first');

  const schemeId = (event.queryStringParameters || {}).scheme_id;
  if (!schemeId) return err(400, 'scheme_id query parameter is required');

  const db = getServiceClient();
  const { data: member } = await db.from('ajo_scheme_members').select('id').eq('scheme_id', schemeId).eq('zillion_id', zillionId).maybeSingle();
  if (!member) return err(404, 'You are not a member of this scheme');

  const { data: contributions } = await db.from('ajo_contributions')
    .select('id, amount_kobo, fee_kobo, source, status, diverted_to_collector, created_at')
    .eq('scheme_member_id', member.id).order('created_at', { ascending: false }).limit(200);

  return ok({ contributions: contributions || [] });
};
