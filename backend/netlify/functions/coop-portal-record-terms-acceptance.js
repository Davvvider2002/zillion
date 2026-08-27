/**
 * zillion/backend/netlify/functions/coop-portal-record-terms-acceptance.js
 *
 * POST /api/v1/coop-portal-record-terms-acceptance
 *
 * Records a society admin's agreement to Terms & Conditions / Privacy
 * Policy — for admin-created societies specifically, who never went
 * through the self-service signup checkbox. Shown as a blocking
 * consent step the first time such an admin signs into the portal;
 * coop-portal-society.js's terms_accepted flag is what tells the
 * frontend whether to show it.
 *
 * Uses the portal's own merchant-based JWT (from merchant-login.js),
 * not the wallet app's zillion_id-based token — a separate auth
 * scheme, so this is a separate endpoint from
 * coop-record-terms-acceptance.js rather than a shared one.
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety } = require('../../lib/coopPortalAuth');
const { recordTermsAcceptance, getClientIp } = require('../../lib/coopTermsAcceptance');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');

  const db = getServiceClient();
  const resolved = await resolvePortalSociety(db, auth);
  if (!resolved.ok) return err(resolved.status, resolved.error);

  const result = await recordTermsAcceptance(db, {
    acceptedByType: 'society_admin',
    acceptedById: resolved.society.merchant_id,
    coopId: resolved.society.coop_id,
    ipAddress: getClientIp(event),
  });

  return ok({ success: true, recorded: result.recorded });
};
