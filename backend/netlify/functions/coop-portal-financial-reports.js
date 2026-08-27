/**
 * zillion/backend/netlify/functions/coop-portal-financial-reports.js
 *
 * GET /api/v1/coop-portal-financial-reports?report=trial_balance|income_expenditure|balance_sheet&as_of=YYYY-MM-DD
 *
 * All three reports are computed live from coop_journal_entry_lines
 * via backend/lib/coopFinancialReports.js — nothing here is stored
 * separately, so there's no way for a report to drift from the
 * entries behind it. Gated behind the Accounting add-on, same as the
 * rest of the accounting module.
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety } = require('../../lib/coopPortalAuth');
const { hasAddon }             = require('../../lib/coopEntitlements');
const { computeTrialBalance, computeIncomeExpenditure, computeBalanceSheet } = require('../../lib/coopFinancialReports');

const VALID_REPORTS = ['trial_balance', 'income_expenditure', 'balance_sheet'];

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
  const coopId = resolved.society.coop_id;

  if (!(await hasAddon(db, coopId, 'accounting'))) return err(403, 'The Accounting & Finance module is not on your current plan');

  const report = event.queryStringParameters?.report;
  const asOf = event.queryStringParameters?.as_of || null;
  if (!VALID_REPORTS.includes(report)) return err(400, `report must be one of: ${VALID_REPORTS.join(', ')}`);

  let data;
  if (report === 'trial_balance') data = await computeTrialBalance(db, coopId, asOf);
  if (report === 'income_expenditure') data = await computeIncomeExpenditure(db, coopId, asOf);
  if (report === 'balance_sheet') data = await computeBalanceSheet(db, coopId, asOf);

  return ok({ report, as_of: asOf, base_currency: resolved.society.base_currency || 'NGN', ...data });
};
