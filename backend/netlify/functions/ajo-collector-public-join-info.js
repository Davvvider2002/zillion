/**
 * zillion/backend/netlify/functions/ajo-collector-public-join-info.js
 *
 * GET /api/v1/ajo-collector-public-join-info
 *
 * Public, unauthenticated - powers the collector join page's initial display (the joining fee) before a
 * prospect has any identity at all. There is exactly one platform-wide fee, set by Zillion Admin
 * (admin-ajo-collector-platform-fee.js) - collectors work for Zillion Ajo, not for whoever shared the link,
 * so there's no admin to look up.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const db = getServiceClient();
  const { data: settings } = await db.from('ajo_collector_platform_settings').select('joining_fee_kobo').eq('id', true).maybeSingle();
  if (!settings) return err(404, 'Collector recruitment is not open yet — Zillion has not set a registration fee.');

  return ok({ joining_fee_kobo: settings.joining_fee_kobo });
};
