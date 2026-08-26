/**
 * zillion/backend/netlify/functions/coop-portal-loan-history-report.js
 *
 * GET /api/v1/coop-portal-loan-history-report
 *
 * Member-by-member loan history with full repayment trail — separate
 * from the financial statements (trial_balance/income_expenditure/
 * balance_sheet) since this is operational loan tracking, not a
 * financial statement, and isn't gated behind the Accounting add-on
 * for that reason.
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety } = require('../../lib/coopPortalAuth');
const { computeLoanHistoryReport } = require('../../lib/coopLoanHistoryReport');

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

  const report = await computeLoanHistoryReport(db, coopId);
  return ok(report);
};
