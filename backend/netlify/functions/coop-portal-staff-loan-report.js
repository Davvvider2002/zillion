/**
 * zillion/backend/netlify/functions/coop-portal-staff-loan-report.js
 *
 * GET /api/v1/coop-portal-staff-loan-report
 *
 * A dedicated monitoring view over every staff loan, distinct from
 * the plain list coop-portal-staff-loans.js already returns: this
 * adds each loan's actual repayment history (from
 * coop_staff_loan_repayments, one row per payroll deduction) with a
 * running balance, a progress percentage, and a projected payoff
 * based on the fixed monthly deduction - plus a society-wide summary
 * (total disbursed, repaid, outstanding across every staff loan) so
 * the admin can see the overall staff loan position at a glance, not
 * just one employee at a time.
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');
const { hasAddon }             = require('../../lib/coopEntitlements');

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

  if (!(await requirePortalPermission(db, auth, 'hr_payroll', 'view'))) {
    return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');
  }
  if (!(await hasAddon(db, coopId, 'payroll'))) {
    return err(403, 'HR & Payroll is not enabled for this society. Add it from the Add-ons tab.');
  }

  const { data: loans } = await db.from('coop_staff_loans')
    .select('id, employee_id, principal_kobo, repayment_months, monthly_deduction_kobo, status, disbursed_at, coop_employees(name, job_title)')
    .eq('coop_id', coopId).order('disbursed_at', { ascending: false });

  const withHistory = await Promise.all((loans || []).map(async (l) => {
    const { data: repayments } = await db.from('coop_staff_loan_repayments')
      .select('amount_kobo, deducted_at, payroll_run_id').eq('staff_loan_id', l.id).order('deducted_at', { ascending: true });

    let runningBalance = l.principal_kobo;
    const history = (repayments || []).map(r => {
      runningBalance -= r.amount_kobo;
      return { date: r.deducted_at, amount_kobo: r.amount_kobo, balance_kobo: Math.max(0, runningBalance), payroll_run_id: r.payroll_run_id };
    });

    const totalPaidKobo = (repayments || []).reduce((s, r) => s + r.amount_kobo, 0);
    const remainingKobo = Math.max(0, l.principal_kobo - totalPaidKobo);
    const progressPct = l.principal_kobo > 0 ? Math.min(100, Math.round((totalPaidKobo / l.principal_kobo) * 100)) : 0;

    // Projected payoff: how many further monthly deductions at the
    // fixed rate would it take to clear the remaining balance from
    // today, assuming no change in deduction amount.
    let projectedPayoffMonths = null;
    if (remainingKobo > 0 && l.monthly_deduction_kobo > 0) {
      projectedPayoffMonths = Math.ceil(remainingKobo / l.monthly_deduction_kobo);
    }

    return {
      id: l.id,
      employee_name: l.coop_employees?.name || 'Unknown',
      job_title: l.coop_employees?.job_title || null,
      principal_kobo: l.principal_kobo,
      monthly_deduction_kobo: l.monthly_deduction_kobo,
      repayment_months: l.repayment_months,
      status: l.status,
      disbursed_at: l.disbursed_at,
      total_paid_kobo: totalPaidKobo,
      remaining_balance_kobo: remainingKobo,
      progress_pct: progressPct,
      projected_payoff_months: projectedPayoffMonths,
      history,
    };
  }));

  const summary = withHistory.reduce((s, l) => ({
    total_disbursed_kobo: s.total_disbursed_kobo + l.principal_kobo,
    total_repaid_kobo: s.total_repaid_kobo + l.total_paid_kobo,
    total_outstanding_kobo: s.total_outstanding_kobo + l.remaining_balance_kobo,
    active_count: s.active_count + (l.remaining_balance_kobo > 0 ? 1 : 0),
    completed_count: s.completed_count + (l.remaining_balance_kobo === 0 ? 1 : 0),
  }), { total_disbursed_kobo: 0, total_repaid_kobo: 0, total_outstanding_kobo: 0, active_count: 0, completed_count: 0 });

  return ok({ loans: withHistory, summary });
};
