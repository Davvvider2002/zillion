/**
 * zillion/backend/netlify/functions/public-coop-addon-modules.js
 *
 * GET /api/v1/public-coop-addon-modules
 *
 * Public, unauthenticated — lists only ACTIVE add-on modules, for the
 * landing page's signup flow. Deliberately minimal: name, description,
 * price. Inactive add-ons (no price set yet, or admin has paused them)
 * never appear here, so nothing unpriced is ever offered for sale.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const db = getServiceClient();
  const { data, error } = await db.from('coop_addon_modules')
    .select('key, name, description, price_kobo').eq('active', true).order('key');
  if (error) return err(500, error.message);

  return ok({ addons: data || [] });
};
