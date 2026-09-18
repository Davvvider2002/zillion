/**
 * zillion/backend/netlify/functions/zillion-member-products.js
 *
 * GET /api/v1/zillion-member-products
 *
 * The single check that decides what the wallet shows right after
 * sign-in: does this zillion_id have any active Coop membership, any
 * active Ajo membership, both, or neither?
 *
 *   - Both        -> the wallet shows the Coop/Ajo chooser (see the
 *                     standalone Ajo proposal, Part 1.3 UX note) and
 *                     keeps a persistent switcher visible afterward.
 *   - Exactly one  -> the wallet goes straight there. No added
 *                     friction for someone who has only ever used
 *                     one of the two products.
 *   - Neither      -> plain Zil-wallet view; Coop and Ajo are things
 *                     to discover, not to choose between.
 *
 * Kept as one dedicated endpoint, rather than having the wallet infer
 * this by calling coop-member-my-societies and ajo-member-my-groups
 * separately and combining the results client-side - a single round
 * trip on the screen that gates first paint after login.
 *
 * Auth: wallet JWT.
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
  if (!zillionId) return ok({ has_coop: false, has_ajo: false, show_chooser: false });

  const db = getServiceClient();

  const [{ count: coopCount }, { count: ajoCount }] = await Promise.all([
    db.from('coop_members').select('id', { count: 'exact', head: true }).eq('zillion_id', zillionId).eq('status', 'ACTIVE'),
    db.from('ajo_scheme_members').select('id', { count: 'exact', head: true }).eq('zillion_id', zillionId).eq('status', 'ACTIVE'),
  ]);

  const hasCoop = (coopCount || 0) > 0;
  const hasAjo = (ajoCount || 0) > 0;

  return ok({
    has_coop: hasCoop,
    has_ajo: hasAjo,
    show_chooser: hasCoop && hasAjo,
  });
};
