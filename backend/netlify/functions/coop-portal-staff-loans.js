/**
 * zillion/backend/netlify/functions/coop-portal-staff-loans.js
 *
 * GET  /api/v1/coop-portal-staff-loans
 * POST /api/v1/coop-portal-staff-loans   { action: 'create', ... }
 *
 * A staff loan is the cooperative acting as an EMPLOYER lending to its
 * own staff - no interest, no penalties, repaid automatically via
 * monthly payroll deduction until fully paid off. Deliberately kept
 * entirely separate from coop_loans (the member-facing cooperative
 * loan system) even when the same person is both an employee and a
 * cooperative member - the two loan types never mix.
 *
 * Gated behind the HR & Payroll add-on.
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');
const { hasAddon }             = require('../../lib/coopEntitlements');

async function computeRemainingBalance(db, staffLoanId, principalKobo) {
  const { data: repayments } = await db.from('coop_staff_loan_repayments').select('amount_kobo').eq('staff_loan_id', staffLoanId);
  const paidSoFar = (repayments || []).reduce((s, r) => s + r.amount_kobo, 0);
  return Math.max(0, principalKobo - paidSoFar);
}

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');

  const db = getServiceClient();
  const resolved = await resolvePortalSociety(db, auth);
  if (!resolved.ok) return err(resolved.status, resolved.error);
  const coopId = resolved.society.coop_id;

  if (!(await hasAddon(db, coopId, 'payroll'))) {
    return err(403, 'HR & Payroll is not enabled for this society. Add it from the Add-ons tab.');
  }

  if (event.httpMethod === 'GET') {
    if (!(await requirePortalPermission(db, auth, 'hr_payroll', 'view'))) {
      return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');
    }
    const { data: loans } = await db.from('coop_staff_loans')
      .select('id, employee_id, principal_kobo, repayment_months, monthly_deduction_kobo, status, disbursed_at, coop_employees(name, job_title)')
      .eq('coop_id', coopId).order('disbursed_at', { ascending: false });

    const withBalance = await Promise.all((loans || []).map(async (l) => ({
      ...l,
      employee_name: l.coop_employees?.name || null,
      remaining_balance_kobo: await computeRemainingBalance(db, l.id, l.principal_kobo),
    })));

    return ok({ staff_loans: withBalance });
  }

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  if (!(await requirePortalPermission(db, auth, 'hr_payroll', 'create'))) {
    return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  if (body.action !== 'create') return err(400, 'Unknown action. Use: create');

  const { employee_id, principal_kobo, repayment_months } = body;
  if (!employee_id) return err(400, 'employee_id is required');
  if (!Number.isInteger(principal_kobo) || principal_kobo <= 0) return err(400, 'principal_kobo must be a positive integer');
  if (!Number.isInteger(repayment_months) || repayment_months <= 0) return err(400, 'repayment_months must be a positive integer');

  const { data: employee } = await db.from('coop_employees').select('id, status').eq('id', employee_id).eq('coop_id', coopId).maybeSingle();
  if (!employee) return err(404, 'Employee not found in your society');
  if (employee.status !== 'ACTIVE') return err(400, 'Cannot create a staff loan for a terminated employee');

  const { data: existingActive } = await db.from('coop_staff_loans').select('id').eq('employee_id', employee_id).eq('status', 'ACTIVE').maybeSingle();
  if (existingActive) return err(400, 'This employee already has an active staff loan. It must be fully repaid before a new one can be created.');

  const monthlyDeductionKobo = Math.ceil(principal_kobo / repayment_months);

  const { data: created, error: insertErr } = await db.from('coop_staff_loans').insert({
    coop_id: coopId, employee_id, principal_kobo, repayment_months,
    monthly_deduction_kobo: monthlyDeductionKobo, created_by: auth.payload.merchant_id,
  }).select().single();
  if (insertErr) return err(500, `Failed to create staff loan: ${insertErr.message}`);

  return ok({ success: true, staff_loan: created });
};
