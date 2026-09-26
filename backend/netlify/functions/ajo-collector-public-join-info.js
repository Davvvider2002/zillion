/**
 * zillion/backend/netlify/functions/ajo-collector-public-join-info.js
 *
 * GET /api/v1/ajo-collector-public-join-info?admin_id=...
 *
 * Public, unauthenticated - powers the collector join page's initial
 * display (the joining fee) before a prospect has any identity at
 * all. Deliberately exposes nothing about the recruiting admin
 * themselves - no name, no phone, no scheme details - only whether
 * this link is still active and what it costs to join.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const adminId = (event.queryStringParameters || {}).admin_id;
  if (!adminId) return err(400, 'admin_id query parameter is required');

  const db = getServiceClient();
  const { data: settings } = await db.from('ajo_collector_recruitment_settings')
    .select('joining_fee_kobo').eq('admin_zillion_id', adminId).maybeSingle();
  if (!settings) return err(404, 'This join link is no longer active');

  return ok({ admin_id: adminId, joining_fee_kobo: settings.joining_fee_kobo });
};
