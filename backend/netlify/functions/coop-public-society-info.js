/**
 * zillion/backend/netlify/functions/coop-public-society-info.js
 *
 * GET /api/v1/coop-public-society-info?coop_id=...
 *
 * Public, unauthenticated - powers the join page's initial display
 * (society name, current joining fee) before a prospect has any
 * identity at all. Deliberately returns only what's needed to render
 * that page; nothing about members, dues, loans, or anything else
 * about the society is exposed here.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const coopId = (event.queryStringParameters || {}).coop_id;
  if (!coopId) return err(400, 'coop_id query parameter is required');

  const db = getServiceClient();
  const { data: society } = await db.from('coop_societies')
    .select('coop_id, name, joining_fee_kobo').eq('coop_id', coopId).maybeSingle();
  if (!society) return err(404, 'Society not found');

  return ok({ coop_id: society.coop_id, name: society.name, joining_fee_kobo: society.joining_fee_kobo || 0 });
};
