/**
 * zillion/backend/netlify/functions/coop-portal-investment-withdraw.js
 *
 * POST /api/v1/coop-portal-investment-withdraw
 *
 * Admin-recorded early withdrawal (same "admin confirms a real
 * request" pattern as recording a savings payment) - withdraws an
 * ACTIVE investment before its maturity date, applying whatever early
 * withdrawal penalty the product is configured with (0 if none).
 *
 * Gated behind the Investment add-on.
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');
const { hasAddon }             = require('../../lib/coopEntitlements');
const { processEarlyWithdrawal } = require('../../lib/coopInvestmentLifecycle');

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
  const coopId = resolved.society.coop_id;

  if (!(await requirePortalPermission(db, auth, 'investment'))) {
    return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');
  }

  if (!(await hasAddon(db, coopId, 'investment'))) {
    return err(403, 'Investment is not enabled for this society. Add it from the Add-ons tab.');
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const { member_investment_id } = body;
  if (!member_investment_id) return err(400, 'member_investment_id is required');

  const { data: investment } = await db.from('coop_member_investments')
    .select('*').eq('id', member_investment_id).eq('coop_id', coopId).maybeSingle();
  if (!investment) return err(404, 'Investment not found in your society');

  const { data: product } = await db.from('coop_investment_products').select('*').eq('id', investment.product_id).maybeSingle();
  if (!product) return err(404, 'Investment product not found');

  const result = await processEarlyWithdrawal(db, investment, product);
  if (!result.success) return err(400, result.error);

  return ok({ success: true, penalty_kobo: result.penaltyKobo });
};
