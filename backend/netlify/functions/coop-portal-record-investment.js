/**
 * zillion/backend/netlify/functions/coop-portal-record-investment.js
 *
 * POST /api/v1/coop-portal-record-investment
 *
 * Admin records a member buying units of an investment product -
 * matches the existing "Record share" / "Record savings payment"
 * pattern (admin confirms a real payment already happened outside the
 * platform). Member-initiated self-service purchase is a logical
 * follow-on, not required to make investment products usable.
 *
 * Gated behind the Investment add-on.
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');
const { hasAddon }             = require('../../lib/coopEntitlements');
const { accountingIsReady, getAccounts, postEntry } = require('../../lib/coopAccountingHelpers');

const BANK_ACCOUNT_CODE = '1010';
const MEMBER_INVESTMENT_PAYABLE_CODE = '2210';

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST' && event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');

  const db = getServiceClient();
  const resolved = await resolvePortalSociety(db, auth);
  if (!resolved.ok) return err(resolved.status, resolved.error);
  const coopId = resolved.society.coop_id;

  if (!(await hasAddon(db, coopId, 'investment'))) {
    return err(403, 'Investment is not enabled for this society. Add it from the Add-ons tab.');
  }

  if (event.httpMethod === 'GET') {
    if (!(await requirePortalPermission(db, auth, 'investment', 'view'))) {
      return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');
    }
    const productId = (event.queryStringParameters || {}).product_id;
    if (!productId) return err(400, 'product_id query param is required');

    const { data: investments } = await db.from('coop_member_investments')
      .select('*, coop_members(name, phone_normalized)').eq('product_id', productId).eq('coop_id', coopId)
      .order('purchased_at', { ascending: false });

    const withAccrued = await Promise.all((investments || []).map(async (inv) => {
      const { data: accruals } = await db.from('coop_investment_accruals').select('amount_kobo').eq('member_investment_id', inv.id);
      const totalAccruedKobo = (accruals || []).reduce((s, a) => s + a.amount_kobo, 0);
      return {
        id: inv.id, member_name: inv.coop_members?.name || inv.coop_members?.phone_normalized || 'Unknown',
        units_purchased: inv.units_purchased, principal_kobo: inv.principal_kobo, maturity_date: inv.maturity_date,
        status: inv.status, auto_reinvest: inv.auto_reinvest, total_accrued_kobo: totalAccruedKobo,
      };
    }));

    return ok({ investments: withAccrued });
  }

  if (!(await requirePortalPermission(db, auth, 'investment', 'create'))) {
    return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const { member_id, product_id, units } = body;
  if (!member_id) return err(400, 'member_id is required');
  if (!product_id) return err(400, 'product_id is required');
  if (!Number.isInteger(units) || units <= 0) return err(400, 'units must be a positive integer');

  const { data: member } = await db.from('coop_members').select('id, name').eq('id', member_id).eq('coop_id', coopId).maybeSingle();
  if (!member) return err(400, 'That member does not belong to this society');

  const { data: product } = await db.from('coop_investment_products').select('*').eq('id', product_id).eq('coop_id', coopId).eq('active', true).maybeSingle();
  if (!product) return err(404, 'Investment product not found or not active');

  if (product.product_type === 'general') {
    const unitsRemaining = product.total_units - product.units_sold;
    if (units > unitsRemaining) return err(400, `Only ${unitsRemaining} unit(s) remain available in this pooled product`);
  }

  const principalKobo = units * product.unit_price_kobo;
  const purchasedAt = new Date();
  const maturityDate = new Date(purchasedAt);
  maturityDate.setMonth(maturityDate.getMonth() + product.tenure_months);

  const { data: investment, error: insertErr } = await db.from('coop_member_investments').insert({
    coop_id: coopId, member_id, product_id, units_purchased: units, principal_kobo: principalKobo,
    maturity_date: maturityDate.toISOString().slice(0, 10),
    auto_reinvest: body.auto_reinvest === true,
  }).select().single();
  if (insertErr) return err(500, `Failed to record investment: ${insertErr.message}`);

  await db.from('coop_investment_products').update({ units_sold: product.units_sold + units }).eq('id', product_id);

  try {
    if (await accountingIsReady(db, coopId)) {
      const accounts = await getAccounts(db, coopId, [BANK_ACCOUNT_CODE, MEMBER_INVESTMENT_PAYABLE_CODE]);
      const bank = accounts[BANK_ACCOUNT_CODE];
      const investmentPayable = accounts[MEMBER_INVESTMENT_PAYABLE_CODE];
      if (bank && investmentPayable) {
        const memberLabel = member.name ? `${member.name} (Member #${String(member.id).slice(0, 8)})` : `Member #${String(member.id).slice(0, 8)}`;
        await postEntry(db, coopId, `Investment purchase — ${product.name} — ${memberLabel}`, `portal:${auth.payload.merchant_id}`, bank, investmentPayable, principalKobo);
      }
    }
  } catch (e) {
    console.error('[coop-portal-record-investment] accounting post failed (non-fatal):', e.message);
  }

  return ok({ success: true, investment });
};
