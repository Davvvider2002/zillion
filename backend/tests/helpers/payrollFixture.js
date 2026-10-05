/**
 * Deterministic payroll fixture + runner, shared by the golden-record generator and the regression test.
 * 40 employees (some inactive, some without salary set), mixed components, staff loans at different stages
 * (including one whose final instalment is capped by what remains), and Nigeria-style statutory config + PAYE bands.
 */
'use strict';
const path = require('path');
const LIB = path.join(__dirname, '..', '..', 'lib');
const FN = path.join(__dirname, '..', '..', 'netlify', 'functions');
const { makeDb } = require('./fakeDb');

const DEFAULT_N = 40;
function buildTables(N = DEFAULT_N) {
  const emp = [], comps = [], loans = [], repay = [];
  for (let i = 1; i <= N; i++) {
    const id = `E${String(i).padStart(3, '0')}`;
    emp.push({ id, coop_id: 'C1', status: i % 13 === 0 ? 'INACTIVE' : 'ACTIVE' });
    if (i % 9 === 0) continue;                                   // no salary set yet -> must be skipped, not paid zero
    const basic = (120000 + i * 37000) * 100;                    // 157k .. 1.6m naira a month
    comps.push({ id: `c${i}a`, employee_id: id, component_type: 'basic', amount_kobo: basic, active: true });
    comps.push({ id: `c${i}b`, employee_id: id, component_type: 'housing', amount_kobo: Math.round(basic * 0.4), active: true });
    if (i % 2 === 0) comps.push({ id: `c${i}c`, employee_id: id, component_type: 'transport', amount_kobo: 3500000, active: true });
    if (i % 5 === 0) comps.push({ id: `c${i}x`, employee_id: id, component_type: 'allowance', amount_kobo: 9900000, active: false }); // inactive: ignored
  }
  // staff loans: every 4th active employee; repayments to varying stages
  let l = 0;
  for (const e of emp) {
    const i = Number(e.id.slice(1));
    if (e.status !== 'ACTIVE' || i % 4 !== 0 || i % 9 === 0) continue;
    l++;
    const principal = 60000000 + l * 5000000, monthly = 5000000 + l * 250000;
    loans.push({ id: `L${l}`, employee_id: e.id, principal_kobo: principal, monthly_deduction_kobo: monthly, status: 'ACTIVE' });
    // loan 3 is paid down to a remainder smaller than one instalment; loans 1-9 pay l instalments (this is what the golden
    // record was taken against). Beyond that, repayments are kept to a handful per loan so a 1,300-employee run exercises
    // headcount scaling rather than generating tens of thousands of repayment rows.
    const paidMonths = l === 3 ? Math.floor(principal / monthly) : (l <= 9 ? l : (l % 7) + 1);
    for (let m = 0; m < paidMonths; m++) repay.push({ id: `r${l}-${m}`, staff_loan_id: `L${l}`, amount_kobo: monthly });
  }
  return {
    coop_employees: emp, coop_employee_salary_components: comps, coop_staff_loans: loans, coop_staff_loan_repayments: repay,
    coop_statutory_config: [
      ['pension_employee_percent', 8], ['pension_employer_percent', 10], ['nhf_percent', 2.5], ['nsitf_percent', 1],
      ['cra_percent_of_gross', 20], ['cra_flat_amount_kobo', 20000000], ['cra_additional_percent', 1],
    ].map(([config_key, config_value_numeric]) => ({ config_key, config_value_numeric })),
    coop_paye_bands: [
      [1, 30000000, 7], [2, 30000000, 11], [3, 50000000, 15], [4, 50000000, 19], [5, 160000000, 21], [6, null, 24],
    ].map(([band_order, band_size_kobo, rate_percent]) => ({ band_order, band_size_kobo, rate_percent, active: true })),
    coop_payroll_runs: [], coop_payroll_run_lines: [],
  };
}

/** Runs create_draft through the real handler against the fixture and returns the lines it wrote, sorted. */
async function runCreateDraft(n = DEFAULT_N) {
  const db = makeDb(buildTables(n), { defaults: { coop_payroll_runs: () => ({ id: 'RUN-1' }) } });
  const stub = (mod, exports) => { require.cache[require.resolve(path.join(LIB, mod))] = { id: mod, filename: mod, loaded: true, exports }; };
  stub('supabase', { getServiceClient: () => db });
  stub('validators', { verifyJWT: () => ({ valid: true, payload: { merchant_id: 'M1', role: 'merchant' } }) });
  stub('coopPortalAuth', { resolvePortalSociety: async () => ({ ok: true, society: { coop_id: 'C1' } }), requirePortalPermission: async () => true });
  stub('coopEntitlements', { hasAddon: async () => true });
  delete require.cache[require.resolve(path.join(FN, 'coop-portal-payroll-run'))];
  const handler = require(path.join(FN, 'coop-portal-payroll-run')).handler;
  const res = await handler({ httpMethod: 'POST', headers: { authorization: 'Bearer x' },
    body: JSON.stringify({ action: 'create_draft', period_label: 'Oct 2026', period_start: '2026-10-01', period_end: '2026-10-31' }) });
  const lines = db.tables.coop_payroll_run_lines.map(({ id, payroll_run_id, ...rest }) => rest).sort((a, b) => a.employee_id.localeCompare(b.employee_id));
  return { status: res.statusCode, body: JSON.parse(res.body), lines, queryCount: db.queryCount };
}
module.exports = { runCreateDraft, DEFAULT_N };
