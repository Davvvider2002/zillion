/**
 * zillion/backend/netlify/functions/coop-portal-payroll-run.js
 *
 * GET  /api/v1/coop-portal-payroll-run
 * POST /api/v1/coop-portal-payroll-run   { action: 'create_draft'|'process', ... }
 *
 * Two-step, matching the draft-then-approve pattern already used for
 * dividends elsewhere in this build: create_draft computes every
 * active employee's pay and statutory deductions so it can be
 * reviewed before anything is committed; process finalizes it -
 * applies any staff loan deductions and posts one aggregate
 * accounting entry for the whole run, not one per employee (standard
 * payroll accounting practice, and far more usable in the ledger).
 *
 * Gated behind the HR & Payroll add-on.
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');
const { hasAddon }             = require('../../lib/coopEntitlements');
const { computeMonthlyStatutoryDeductions } = require('../../lib/coopStatutoryDeductions');
const { accountingIsReady, getAccounts, postEntryLines } = require('../../lib/coopAccountingHelpers');

const BANK_ACCOUNT_CODE = '1010';
const STAFF_LOANS_RECEIVABLE_CODE = '1160';
const PAYE_PAYABLE_CODE = '2110';
const PENSION_PAYABLE_CODE = '2120';
const NHF_PAYABLE_CODE = '2130';
const NSITF_PAYABLE_CODE = '2140';
const STAFF_COSTS_CODE = '5100';
const EMPLOYER_PENSION_EXPENSE_CODE = '5110';

async function computeStaffLoanRemainingBalance(db, staffLoanId, principalKobo) {
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
    const runId = (event.queryStringParameters || {}).payroll_run_id;

    if (runId) {
      const { data: run } = await db.from('coop_payroll_runs').select('*').eq('id', runId).eq('coop_id', coopId).maybeSingle();
      if (!run) return err(404, 'Payroll run not found');

      const { data: lines } = await db.from('coop_payroll_run_lines')
        .select('*, coop_employees(name, job_title)').eq('payroll_run_id', runId).order('gross_pay_kobo', { ascending: false });

      const enriched = (lines || []).map(l => ({
        employee_name: l.coop_employees?.name || 'Unknown',
        job_title: l.coop_employees?.job_title || null,
        basic_salary_kobo: l.basic_salary_kobo,
        allowances_kobo: l.gross_pay_kobo - l.basic_salary_kobo,
        gross_pay_kobo: l.gross_pay_kobo,
        paye_kobo: l.paye_kobo,
        pension_employee_kobo: l.pension_employee_kobo,
        pension_employer_kobo: l.pension_employer_kobo,
        nhf_kobo: l.nhf_kobo,
        nsitf_kobo: l.nsitf_kobo,
        staff_loan_deduction_kobo: l.staff_loan_deduction_kobo,
        net_pay_kobo: l.net_pay_kobo,
      }));

      return ok({ run, lines: enriched });
    }

    const { data: runs } = await db.from('coop_payroll_runs')
      .select('id, period_label, period_start, period_end, status, processed_at')
      .eq('coop_id', coopId).order('created_at', { ascending: false });
    return ok({ runs: runs || [] });
  }

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  // create_draft makes a new run; process modifies an existing draft's status.
  if (!(await requirePortalPermission(db, auth, 'hr_payroll', body.action === 'create_draft' ? 'create' : 'edit'))) {
    return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');
  }

  if (body.action === 'create_draft') {
    const { period_label, period_start, period_end } = body;
    if (!period_label || !period_start || !period_end) return err(400, 'period_label, period_start, and period_end are required');

    const { data: run, error: runErr } = await db.from('coop_payroll_runs').insert({
      coop_id: coopId, period_label, period_start, period_end, status: 'draft', created_by: auth.payload.merchant_id,
    }).select().single();
    if (runErr) return err(500, `Failed to create payroll run: ${runErr.message}`);

    const { data: employees } = await db.from('coop_employees').select('id').eq('coop_id', coopId).eq('status', 'ACTIVE');

    const lines = [];
    for (const emp of (employees || [])) {
      const { data: components } = await db.from('coop_employee_salary_components')
        .select('component_type, amount_kobo').eq('employee_id', emp.id).eq('active', true);
      if (!components || components.length === 0) continue; // no salary set yet - skip rather than pay ₦0

      const basic = components.find(c => c.component_type === 'basic');
      const grossMonthlyKobo = components.reduce((s, c) => s + c.amount_kobo, 0);
      const basicMonthlyKobo = basic?.amount_kobo || 0;

      const deductions = await computeMonthlyStatutoryDeductions(db, { grossMonthlyKobo, basicMonthlyKobo });

      // If this employee has an active staff loan, deduct this month's
      // installment - capped at whatever genuinely remains, so the
      // final installment never over-deducts past what's actually owed.
      let staffLoanDeductionKobo = 0;
      const { data: staffLoan } = await db.from('coop_staff_loans')
        .select('id, principal_kobo, monthly_deduction_kobo').eq('employee_id', emp.id).eq('status', 'ACTIVE').maybeSingle();
      if (staffLoan) {
        const remaining = await computeStaffLoanRemainingBalance(db, staffLoan.id, staffLoan.principal_kobo);
        staffLoanDeductionKobo = Math.min(staffLoan.monthly_deduction_kobo, remaining);
      }

      const netPayKobo = grossMonthlyKobo - deductions.payeKobo - deductions.pensionEmployeeKobo - deductions.nhfKobo - staffLoanDeductionKobo;

      lines.push({
        payroll_run_id: run.id, employee_id: emp.id,
        gross_pay_kobo: grossMonthlyKobo, basic_salary_kobo: basicMonthlyKobo,
        paye_kobo: deductions.payeKobo, pension_employee_kobo: deductions.pensionEmployeeKobo,
        pension_employer_kobo: deductions.pensionEmployerKobo, nhf_kobo: deductions.nhfKobo, nsitf_kobo: deductions.nsitfKobo,
        staff_loan_deduction_kobo: staffLoanDeductionKobo, net_pay_kobo: netPayKobo,
      });
    }

    if (lines.length > 0) await db.from('coop_payroll_run_lines').insert(lines);

    return ok({ success: true, payroll_run_id: run.id, employees_included: lines.length });
  }

  if (body.action === 'process') {
    const { payroll_run_id } = body;
    if (!payroll_run_id) return err(400, 'payroll_run_id is required');

    const { data: run } = await db.from('coop_payroll_runs').select('*').eq('id', payroll_run_id).eq('coop_id', coopId).maybeSingle();
    if (!run) return err(404, 'Payroll run not found');
    if (run.status === 'processed') return err(400, 'This payroll run has already been processed');

    const { data: lines } = await db.from('coop_payroll_run_lines').select('*').eq('payroll_run_id', payroll_run_id);
    if (!lines || lines.length === 0) return err(400, 'This payroll run has no employees to process');

    // Apply staff loan deductions first - each one becomes a real
    // repayment row, and the loan is marked paid off if this
    // installment brings it to zero.
    for (const line of lines) {
      if (line.staff_loan_deduction_kobo <= 0) continue;
      const { data: staffLoan } = await db.from('coop_staff_loans')
        .select('id, principal_kobo').eq('employee_id', line.employee_id).eq('status', 'ACTIVE').maybeSingle();
      if (!staffLoan) continue;

      await db.from('coop_staff_loan_repayments').insert({
        staff_loan_id: staffLoan.id, payroll_run_id, amount_kobo: line.staff_loan_deduction_kobo,
      });
      const remaining = await computeStaffLoanRemainingBalance(db, staffLoan.id, staffLoan.principal_kobo);
      if (remaining <= 0) await db.from('coop_staff_loans').update({ status: 'PAID_OFF' }).eq('id', staffLoan.id);
    }

    const sum = (key) => lines.reduce((s, l) => s + l[key], 0);
    const totalGross = sum('gross_pay_kobo');
    const totalNsitf = sum('nsitf_kobo');
    const totalEmployerPension = sum('pension_employer_kobo');
    const totalNetPay = sum('net_pay_kobo');
    const totalPaye = sum('paye_kobo');
    const totalPension = sum('pension_employee_kobo') + totalEmployerPension;
    const totalNhf = sum('nhf_kobo');
    const totalStaffLoanDeduction = sum('staff_loan_deduction_kobo');

    try {
      if (await accountingIsReady(db, coopId)) {
        const accounts = await getAccounts(db, coopId, [
          BANK_ACCOUNT_CODE, STAFF_LOANS_RECEIVABLE_CODE, PAYE_PAYABLE_CODE,
          PENSION_PAYABLE_CODE, NHF_PAYABLE_CODE, NSITF_PAYABLE_CODE,
          STAFF_COSTS_CODE, EMPLOYER_PENSION_EXPENSE_CODE,
        ]);
        const bank = accounts[BANK_ACCOUNT_CODE];
        const staffLoansReceivable = accounts[STAFF_LOANS_RECEIVABLE_CODE];
        const payePayable = accounts[PAYE_PAYABLE_CODE];
        const pensionPayable = accounts[PENSION_PAYABLE_CODE];
        const nhfPayable = accounts[NHF_PAYABLE_CODE];
        const nsitfPayable = accounts[NSITF_PAYABLE_CODE];
        const staffCosts = accounts[STAFF_COSTS_CODE];
        const employerPensionExpense = accounts[EMPLOYER_PENSION_EXPENSE_CODE];

        if (bank && staffLoansReceivable && payePayable && pensionPayable && nhfPayable && nsitfPayable && staffCosts && employerPensionExpense) {
          const description = `Payroll — ${run.period_label}`;
          const lineItems = [
            { account: staffCosts, type: 'debit', amountKobo: totalGross + totalNsitf },
            { account: employerPensionExpense, type: 'debit', amountKobo: totalEmployerPension },
            { account: bank, type: 'credit', amountKobo: totalNetPay },
            { account: payePayable, type: 'credit', amountKobo: totalPaye },
            { account: pensionPayable, type: 'credit', amountKobo: totalPension },
            { account: nhfPayable, type: 'credit', amountKobo: totalNhf },
            { account: nsitfPayable, type: 'credit', amountKobo: totalNsitf },
          ];
          if (totalStaffLoanDeduction > 0) {
            lineItems.push({ account: staffLoansReceivable, type: 'credit', amountKobo: totalStaffLoanDeduction });
          }
          // Zero-amount lines are dropped - postEntryLines expects every
          // line to be real, and a run with (say) no NSITF configured
          // would otherwise post a meaningless ₦0 line.
          await postEntryLines(db, coopId, description, `portal:${auth.payload.merchant_id}`, lineItems.filter(l => l.amountKobo > 0));
        }
      }
    } catch (e) {
      console.error('[coop-portal-payroll-run] accounting post failed (non-fatal):', e.message);
    }

    await db.from('coop_payroll_runs').update({ status: 'processed', processed_at: new Date().toISOString() }).eq('id', payroll_run_id);

    return ok({ success: true, employees_paid: lines.length, total_net_pay_kobo: totalNetPay });
  }

  return err(400, `Unknown action "${body.action}". Use: create_draft, process`);
};
