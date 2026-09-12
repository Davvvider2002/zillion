/**
 * zillion/backend/netlify/functions/coop-portal-investment-performance.js
 *
 * POST /api/v1/coop-portal-investment-performance
 *
 * For 'variable' return_type products only - an admin records the
 * venture's real, actual performance for a period (which can be
 * negative, a genuine loss), and it's distributed proportionally
 * across every currently ACTIVE investor in that product by their
 * share of total invested principal - the same math already tested
 * in coopInvestmentAccrual.js (verified to sum exactly to the
 * recorded figure for both a gain and a loss).
 *
 * One accounting entry for the whole distribution, not one per
 * investor - direction flips automatically for a loss: a gain debits
 * Investment Return Expense and credits Member Investment Payable; a
 * loss does the reverse, since it's income the venture failed to earn
 * back rather than a cost the society paid out.
 *
 * Gated behind the Investment add-on.
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety } = require('../../lib/coopPortalAuth');
const { hasAddon }             = require('../../lib/coopEntitlements');
const { computeVariableDistribution } = require('../../lib/coopInvestmentAccrual');
const { accountingIsReady, getAccounts, postEntry } = require('../../lib/coopAccountingHelpers');

const INVESTMENT_RETURN_EXPENSE_CODE = '5310';
const MEMBER_INVESTMENT_PAYABLE_CODE = '2210';

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

  if (!(await hasAddon(db, coopId, 'investment'))) {
    return err(403, 'Investment is not enabled for this society. Add it from the Add-ons tab.');
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const { product_id, period_label, net_performance_kobo } = body;
  if (!product_id) return err(400, 'product_id is required');
  if (!period_label) return err(400, 'period_label is required');
  if (!Number.isInteger(net_performance_kobo)) return err(400, 'net_performance_kobo must be an integer (in kobo, negative for a loss)');

  const { data: product } = await db.from('coop_investment_products').select('*').eq('id', product_id).eq('coop_id', coopId).maybeSingle();
  if (!product) return err(404, 'Investment product not found in your society');
  if (product.return_type !== 'variable') return err(400, 'Venture performance can only be recorded for a variable-return product');

  const { data: investments } = await db.from('coop_member_investments')
    .select('id, principal_kobo').eq('product_id', product_id).eq('status', 'ACTIVE');
  if (!investments || investments.length === 0) return err(400, 'No active investors in this product to distribute to');

  const distribution = computeVariableDistribution(net_performance_kobo, investments);

  const { error: perfInsertErr } = await db.from('coop_investment_venture_performance').insert({
    product_id, period_label, net_performance_kobo, recorded_by: auth.payload.merchant_id,
  });
  if (perfInsertErr) return err(500, `Failed to record performance: ${perfInsertErr.message}`);

  const accrualRows = distribution
    .filter(d => d.amount_kobo !== 0)
    .map(d => ({ member_investment_id: d.id, amount_kobo: d.amount_kobo, reason: 'venture_performance' }));
  if (accrualRows.length > 0) await db.from('coop_investment_accruals').insert(accrualRows);

  try {
    if (net_performance_kobo !== 0 && await accountingIsReady(db, coopId)) {
      const accounts = await getAccounts(db, coopId, [INVESTMENT_RETURN_EXPENSE_CODE, MEMBER_INVESTMENT_PAYABLE_CODE]);
      const expense = accounts[INVESTMENT_RETURN_EXPENSE_CODE];
      const payable = accounts[MEMBER_INVESTMENT_PAYABLE_CODE];
      if (expense && payable) {
        const description = `Venture performance — ${product.name} (${period_label})`;
        if (net_performance_kobo > 0) {
          await postEntry(db, coopId, description, `portal:${auth.payload.merchant_id}`, expense, payable, net_performance_kobo);
        } else {
          await postEntry(db, coopId, description, `portal:${auth.payload.merchant_id}`, payable, expense, Math.abs(net_performance_kobo));
        }
      }
    }
  } catch (e) {
    console.error('[coop-portal-investment-performance] accounting post failed (non-fatal):', e.message);
  }

  return ok({ success: true, investors_affected: distribution.length, net_performance_kobo });
};
