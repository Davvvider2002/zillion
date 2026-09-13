/**
 * zillion/backend/netlify/functions/coop-portal-payroll-preview.js
 *
 * POST /api/v1/coop-portal-payroll-preview
 *
 * Computes what an employee's statutory deductions and net pay would
 * be for a given basic salary + allowances - pure preview, nothing is
 * saved. Lets the Add/Set Salary screens show a real breakdown
 * (basic, allowances, gross, PAYE, pension, NHF, net pay) using the
 * same computeMonthlyStatutoryDeductions() the actual payroll run
 * uses, rather than duplicating that math in the frontend where it
 * could drift out of sync with the real calculation.
 *
 * Body: { basic_salary_kobo, allowances: [{ name, amount_kobo }] }
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety } = require('../../lib/coopPortalAuth');
const { hasAddon }             = require('../../lib/coopEntitlements');
const { computeMonthlyStatutoryDeductions } = require('../../lib/coopStatutoryDeductions');

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

  if (!(await hasAddon(db, coopId, 'payroll'))) {
    return err(403, 'HR & Payroll is not enabled for this society. Add it from the Add-ons tab.');
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const basicSalaryKobo = body.basic_salary_kobo;
  if (!Number.isInteger(basicSalaryKobo) || basicSalaryKobo <= 0) return err(400, 'basic_salary_kobo must be a positive integer');

  const allowances = Array.isArray(body.allowances) ? body.allowances : [];
  let allowancesTotalKobo = 0;
  for (const a of allowances) {
    if (!Number.isInteger(a.amount_kobo) || a.amount_kobo < 0) return err(400, `Invalid allowance amount for "${a.name || 'unnamed'}"`);
    allowancesTotalKobo += a.amount_kobo;
  }

  const grossMonthlyKobo = basicSalaryKobo + allowancesTotalKobo;
  const deductions = await computeMonthlyStatutoryDeductions(db, { grossMonthlyKobo, basicMonthlyKobo: basicSalaryKobo });

  const netPayKobo = grossMonthlyKobo - deductions.payeKobo - deductions.pensionEmployeeKobo - deductions.nhfKobo;

  return ok({
    basic_salary_kobo: basicSalaryKobo,
    allowances_total_kobo: allowancesTotalKobo,
    gross_pay_kobo: grossMonthlyKobo,
    paye_kobo: deductions.payeKobo,
    pension_employee_kobo: deductions.pensionEmployeeKobo,
    pension_employer_kobo: deductions.pensionEmployerKobo,
    nhf_kobo: deductions.nhfKobo,
    nsitf_kobo: deductions.nsitfKobo,
    net_pay_kobo: netPayKobo,
  });
};
