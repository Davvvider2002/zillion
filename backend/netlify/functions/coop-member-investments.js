/**
 * zillion/backend/netlify/functions/coop-member-investments.js
 *
 * GET /api/v1/coop-member-investments
 *
 * The actual gap reported: investment products and member holdings
 * were fully built (coop_investment_products, coop_member_investments,
 * coop_investment_accruals) but only ever readable through the portal
 * (admin-only auth). A member had no way to even see what was on
 * offer, let alone what they already held. This is the read side for
 * the wallet - wallet JWT, not portal auth, and always scoped to the
 * caller's own holdings, never another member's.
 *
 * Returns active products (with real-time capacity remaining for
 * pooled/general products) alongside the caller's own investments and
 * their accrued returns to date - the two things a member actually
 * needs to decide whether to invest and to see what they already have.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { resolveMemberForZillionId } = require('../../lib/coopMemberResolve');
const { hasAddon } = require('../../lib/coopEntitlements');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  const zillionId = auth.payload.zillion_id;
  if (!zillionId) return ok({ is_coop_member: false });

  const db = getServiceClient();
  const member = await resolveMemberForZillionId(db, zillionId, 'id, coop_id, name', auth.payload.coop_id || null);
  if (!member) return ok({ is_coop_member: false });

  if (!(await hasAddon(db, member.coop_id, 'investment'))) {
    return ok({ is_coop_member: true, investment_enabled: false, products: [], my_investments: [] });
  }

  const { data: products } = await db.from('coop_investment_products')
    .select('*').eq('coop_id', member.coop_id).eq('active', true).order('created_at', { ascending: true });

  const productsWithCapacity = (products || []).map(p => ({
    id: p.id, name: p.name, product_type: p.product_type, return_type: p.return_type,
    unit_price_kobo: p.unit_price_kobo, tenure_months: p.tenure_months,
    fixed_return_rate_percent: p.fixed_return_rate_percent,
    early_withdrawal_penalty_percent: p.early_withdrawal_penalty_percent,
    units_remaining: p.product_type === 'general' ? Math.max(0, p.total_units - p.units_sold) : null,
    total_units: p.total_units,
  }));

  const { data: myInvestments } = await db.from('coop_member_investments')
    .select('*, coop_investment_products(name, product_type, return_type, unit_price_kobo, fixed_return_rate_percent)')
    .eq('member_id', member.id).order('purchased_at', { ascending: false });

  const myInvestmentsWithAccrued = await Promise.all((myInvestments || []).map(async (inv) => {
    const { data: accruals } = await db.from('coop_investment_accruals').select('amount_kobo').eq('member_investment_id', inv.id);
    const totalAccruedKobo = (accruals || []).reduce((s, a) => s + a.amount_kobo, 0);
    return {
      id: inv.id, product_name: inv.coop_investment_products?.name || 'Unknown product',
      product_type: inv.coop_investment_products?.product_type, return_type: inv.coop_investment_products?.return_type,
      units_purchased: inv.units_purchased, principal_kobo: inv.principal_kobo,
      purchased_at: inv.purchased_at, maturity_date: inv.maturity_date, status: inv.status,
      auto_reinvest: inv.auto_reinvest, total_accrued_kobo: totalAccruedKobo,
    };
  }));

  return ok({
    is_coop_member: true, investment_enabled: true,
    products: productsWithCapacity, my_investments: myInvestmentsWithAccrued,
  });
};
