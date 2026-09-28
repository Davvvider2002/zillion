/**
 * zillion/backend/netlify/functions/coop-portal-kyc-invoices.js
 *
 * GET /api/v1/coop-portal-kyc-invoices
 *
 * This society's own NIN-verification usage invoices — one per month, with running totals for the current
 * (unbilled) month. Viewable by any portal user; paying one is a separate, owner-only action.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { resolvePortalSociety } = require('../../lib/coopPortalAuth');
const billing = require('../../lib/coopKycBilling');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');

  const db = getServiceClient();
  const resolved = await resolvePortalSociety(db, auth);
  if (!resolved.ok) return err(resolved.status, resolved.error);

  try {
    const invoices = await billing.listInvoicesForSociety(db, resolved.society.coop_id);
    const priceKobo = await billing.getKycPriceKobo(db);
    const { data: societyFlags } = await db.from('coop_societies').select('never_expires').eq('coop_id', resolved.society.coop_id).maybeSingle();
    const kycActive = billing.isKycActiveForSociety({ subscription_status: resolved.society.subscription_status, never_expires: societyFlags?.never_expires });
    return ok({ success: true, invoices, price_kobo: priceKobo, can_pay: auth.payload.role === 'merchant', kyc_active: kycActive });
  } catch (e) {
    console.error('[coop-portal-kyc-invoices]', e);
    return err(500, 'Could not load invoices.');
  }
};
