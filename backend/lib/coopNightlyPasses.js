/**
 * zillion/backend/lib/coopNightlyPasses.js
 *
 * The six heavy passes of the scheduled job, as resumable, time-budgeted batches (see coopBatchJob.js):
 *
 *   dues_accrual        recognise dues income, per society that has dues configured
 *   member_statements   the monthly statement email, once per member per month
 *   loan_penalties      the one-off late-repayment penalty per loan
 *   savings_interest    monthly interest per savings plan
 *   investment_accrual  monthly accrual per fixed-return investment
 *   investment_maturity auto-reinvest or mark matured
 *
 * Each does the SAME thing per row as before. What changed is how the rows are reached: in id order a page at a
 * time from a saved cursor, with one bulk read per page for whatever a row needs (its package, whether it has
 * already been credited this month, its loan schedule...) instead of a query per row. The per-row functions
 * themselves are unchanged and still make the final decision, so a hint that is missing or stale can only cost a
 * query, never a wrong credit.
 */
'use strict';

const { fetchAllRows, chunk } = require('./coopPaginate');
const { TimeBudget, createJobStateStore, runBatchedPass, checkPassLag } = require('./coopBatchJob');
const { loadLoanRepaymentInputs, sumBy } = require('./coopSocietyBulk');
const { buildLoanRepaymentStatus } = require('./coopLoanRepaymentStatus');

const MAX_CYCLE_HOURS = 26;   // each pass should get through every row about once a day; longer means it has outgrown its budget
const monthKey = d => `${d.getFullYear()}-${d.getMonth()}`;
const monthStartIso = now => new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

/** Next page after a cursor, in cursor order. Throws on a database error so the engine keeps its saved progress. */
function pager(db, table, cols, orderCol, filters = q => q) {
  return async (cursor, limit) => {
    let q = filters(db.from(table).select(cols));
    if (cursor) q = q.gt(orderCol, cursor);
    const { data, error } = await q.order(orderCol).limit(limit);
    if (error) throw new Error(`${table}: ${error.message}`);
    return data || [];
  };
}
/** All rows whose `col` is in ids, chunked so the URL stays a sane length, and paged. */
async function readIn(db, table, cols, col, ids, { orderCol = 'id', extra = q => q } = {}) {
  const out = [];
  for (const part of chunk([...new Set(ids.filter(x => x != null))])) {
    out.push(...await fetchAllRows(() => extra(db.from(table).select(cols).in(col, part)).order(orderCol)));
  }
  return out;
}

function defaultDeps() {
  return {
    recordDuesAccrual: require('./coopDuesAccounting').recordDuesAccrual,
    computeMemberFullStatement: require('./coopMemberFullStatement').computeMemberFullStatement,
    generateMemberStatementPdf: require('./coopMemberStatementPdf').generateMemberStatementPdf,
    sendEmail: require('./resendEmail').sendEmail,
    emailReady: () => !!((process.env.RESEND_API_KEY || '').trim() && (process.env.RESEND_SENDER_EMAIL || '').trim()),
    applyMonthlyInterestIfEligible: require('./coopSavingsInterest').applyMonthlyInterestIfEligible,
    applyMonthlyAccrualIfEligible: require('./coopInvestmentLifecycle').applyMonthlyAccrualIfEligible,
    processMaturity: require('./coopInvestmentLifecycle').processMaturity,
  };
}

function buildPasses(db, now, d, raise, log) {
  // A credit that fails to record used to vanish (the per-row functions return a reason nobody read). Collect them and
  // raise ONE alert per pass - not one per row, which would bury the admin panel if the database were down.
  const interestFailures = [], accrualFailures = [];
  const summarise = (what, list) => async () => {
    if (!list.length) return;
    await raise({ severity: 'WARNING', message: `${list.length} ${what} could not be recorded (first: ${list[0].error || 'unknown error'})`, context: { failed: list.length, sample: list.slice(0, 5) } });
  };
  return [
    // ── dues income accrual ───────────────────────────────────────────────────────────────────────────────
    // Only societies with dues configured can have anything to accrue; recordDuesAccrual returned
    // 'no_dues_configured' for the rest, after spending queries to find that out.
    { key: 'dues_accrual', cursorOf: s => s.coop_id,
      fetchPage: pager(db, 'coop_societies', 'coop_id', 'coop_id', q => q.gt('dues_amount_kobo', 0)),
      processItem: s => d.recordDuesAccrual(db, s.coop_id) },

    // ── monthly member statements ─────────────────────────────────────────────────────────────────────────
    // Once per member per calendar month. A member with no activity used to be recomputed (statement and all) on
    // EVERY run for the rest of the month, because nothing recorded that they had been looked at; now they are
    // marked as checked. A missed run still just catches up on the next one.
    { key: 'member_statements',
      fetchPage: pager(db, 'coop_members', 'id, email, last_loan_statement_sent_at, last_statement_checked_at', 'id', q => q.eq('status', 'ACTIVE').not('email', 'is', null)),
      processItem: async (member) => {
        if (!d.emailReady()) return;   // computing a statement and PDF that cannot be sent is pure waste
        const current = monthKey(now);
        const inMonth = v => v && monthKey(new Date(v)) === current;
        if (inMonth(member.last_loan_statement_sent_at) || inMonth(member.last_statement_checked_at)) return;

        const statementData = await d.computeMemberFullStatement(db, member.id);
        const hasActivity = statementData && (
          statementData.loans?.some(l => l.transactions?.length) || statementData.savings?.some(s => s.transactions?.length) ||
          statementData.investment?.some(i => i.transactions?.length) || statementData.dues?.transactions?.length);
        if (!hasActivity) { await db.from('coop_members').update({ last_statement_checked_at: now.toISOString() }).eq('id', member.id); return; }

        try {
          const pdfBuffer = await d.generateMemberStatementPdf(statementData);
          const result = await d.sendEmail({
            to: statementData.member.email, toName: statementData.member.name,
            subject: `Your Zillion Coop statement — ${statementData.member.society_name}`,
            htmlContent: `<p>Hi ${statementData.member.name},</p><p>Your monthly statement (savings, loans, investment, and dues) is attached.</p>`,
            attachments: [{ filename: 'member-statement.pdf', content: pdfBuffer.toString('base64') }],
          });
          if (result.sent) await db.from('coop_members').update({ last_loan_statement_sent_at: now.toISOString() }).eq('id', member.id);
        } catch (e) { log.error(`[nightly] statement send failed for member ${member.id}: ${e.message}`); }
      } },

    // ── loan late penalties ───────────────────────────────────────────────────────────────────────────────
    // At most one penalty per loan. Each page's loan schedules, repayments and existing penalties are read in
    // bulk and run through the same pure calculation used everywhere else this figure matters.
    { key: 'loan_penalties',
      fetchPage: pager(db, 'coop_loans', 'id, coop_id, principal_kobo', 'id', q => q.in('status', ['DISBURSED', 'REPAYING'])),
      prepare: async (loans) => {
        const societies = await readIn(db, 'coop_societies', 'coop_id, late_fee_type, late_fee_value, loan_late_fee_type, loan_late_fee_value', 'coop_id', loans.map(l => l.coop_id), { orderCol: 'coop_id' });
        return { societies: new Map(societies.map(s => [s.coop_id, s])), inputs: await loadLoanRepaymentInputs(db, loans.map(l => l.id)) };
      },
      processItem: async (loan, ctx) => {
        const society = ctx.societies.get(loan.coop_id);
        if (!society) return;
        const { schedule, paid, penalty, penaltyCount } = ctx.inputs;
        const status = buildLoanRepaymentStatus({ schedule: schedule.get(loan.id) || [], paidKobo: paid.get(loan.id) || 0, penaltyKobo: penalty.get(loan.id) || 0 }, society, loan.principal_kobo);
        if (!status.is_overdue || status.late_fee_kobo <= 0) return;
        if ((penaltyCount.get(loan.id) || 0) > 0) return;   // already applied once - never re-charged

        const { error: insertErr } = await db.from('coop_loan_penalties').insert({ loan_id: loan.id, coop_id: loan.coop_id, amount_kobo: status.late_fee_kobo, reason: 'Automatic late-repayment penalty' });
        if (insertErr) return;
        try {
          const { accountingIsReady, getAccounts, postEntry } = require('./coopAccountingHelpers');
          if (await accountingIsReady(db, loan.coop_id)) {
            const accounts = await getAccounts(db, loan.coop_id, ['1100', '4160']);
            if (accounts['1100'] && accounts['4160']) await postEntry(db, loan.coop_id, 'Late loan repayment penalty', 'system:scheduled-reconcile', accounts['1100'], accounts['4160'], status.late_fee_kobo);
          }
        } catch (e) { log.error(`[nightly] penalty accounting post failed for loan ${loan.id} (non-fatal): ${e.message}`); }
        await raise({ severity: 'INFO', message: `Late repayment penalty applied to a loan (${loan.coop_id})`, context: { coop_id: loan.coop_id, loan_id: loan.id, penalty_kobo: status.late_fee_kobo } });
      } },

    // ── savings interest ──────────────────────────────────────────────────────────────────────────────────
    // Once per plan per month. One bulk read tells us which plans in the page were already credited this month, so
    // for the rest of the month those cost nothing; balances are read in bulk for the few that still need working out.
    { key: 'savings_interest',
      fetchPage: pager(db, 'coop_savings_plans', 'id, coop_id, member_id, savings_package_id, status', 'id', q => q.eq('status', 'ACTIVE').not('savings_package_id', 'is', null)),
      prepare: async (plans) => {
        const packages = new Map((await readIn(db, 'coop_savings_packages', '*', 'id', plans.map(p => p.savings_package_id))).map(p => [p.id, p]));
        const credited = new Set((await readIn(db, 'coop_savings_transactions', 'savings_plan_id', 'savings_plan_id', plans.map(p => p.id),
          { extra: q => q.eq('source', 'interest_credit').gte('recorded_at', monthStartIso(now)) })).map(r => r.savings_plan_id));
        const need = plans.filter(p => !credited.has(p.id) && packages.get(p.savings_package_id)?.active).map(p => p.id);
        const balances = sumBy(await readIn(db, 'coop_savings_transactions', 'savings_plan_id, amount_kobo', 'savings_plan_id', need), r => r.savings_plan_id, r => r.amount_kobo);
        return { packages, credited, balances };
      },
      processItem: async (plan, ctx) => {
        if (ctx.credited.has(plan.id)) return;
        const result = await d.applyMonthlyInterestIfEligible(db, plan, ctx.packages.get(plan.savings_package_id), now, { alreadyCredited: false, balanceKobo: ctx.balances.get(plan.id) || 0 });
        if (result.applied) await raise({ severity: 'INFO', message: `Monthly savings interest credited (${plan.coop_id})`, context: { coop_id: plan.coop_id, savings_plan_id: plan.id, interest_kobo: result.amountKobo } });
        else if (result.reason === 'insert_failed') interestFailures.push({ coop_id: plan.coop_id, savings_plan_id: plan.id, error: result.error });
      },
      finalize: summarise('monthly savings interest credit(s)', interestFailures) },

    // ── investment accrual (fixed-return products only) ──────────────────────────────────────────────────
    { key: 'investment_accrual',
      fetchPage: pager(db, 'coop_member_investments', 'id, coop_id, member_id, product_id, principal_kobo, status', 'id', q => q.eq('status', 'ACTIVE')),
      prepare: async (investments) => {
        const products = new Map((await readIn(db, 'coop_investment_products', '*', 'id', investments.map(i => i.product_id))).map(p => [p.id, p]));
        const candidates = investments.filter(i => products.get(i.product_id)?.return_type === 'fixed').map(i => i.id);
        const applied = new Set((await readIn(db, 'coop_investment_accruals', 'member_investment_id', 'member_investment_id', candidates,
          { extra: q => q.eq('reason', 'scheduled_accrual').gte('accrued_at', monthStartIso(now)) })).map(r => r.member_investment_id));
        const totals = sumBy(await readIn(db, 'coop_investment_accruals', 'member_investment_id, amount_kobo', 'member_investment_id', candidates.filter(id => !applied.has(id)),
          { extra: q => q.eq('reason', 'scheduled_accrual') }), r => r.member_investment_id, r => r.amount_kobo);
        return { products, applied, totals };
      },
      processItem: async (inv, ctx) => {
        const product = ctx.products.get(inv.product_id);
        if (!product || ctx.applied.has(inv.id)) return;
        const result = await d.applyMonthlyAccrualIfEligible(db, inv, product, now, { alreadyApplied: false, alreadyAccruedKobo: ctx.totals.get(inv.id) || 0 });
        if (result.applied) await raise({ severity: 'INFO', message: `Monthly investment accrual credited (${inv.coop_id})`, context: { coop_id: inv.coop_id, member_investment_id: inv.id, accrual_kobo: result.amountKobo } });
        else if (result.reason === 'insert_failed') accrualFailures.push({ coop_id: inv.coop_id, member_investment_id: inv.id });
      },
      finalize: summarise('monthly investment accrual(s)', accrualFailures) },

    // ── investment maturity ───────────────────────────────────────────────────────────────────────────────
    { key: 'investment_maturity',
      fetchPage: pager(db, 'coop_member_investments', 'id, coop_id, member_id, product_id, principal_kobo, units_purchased, auto_reinvest, status, maturity_date', 'id',
        q => q.eq('status', 'ACTIVE').lte('maturity_date', now.toISOString().slice(0, 10))),
      prepare: async (investments) => ({ products: new Map((await readIn(db, 'coop_investment_products', '*', 'id', investments.map(i => i.product_id))).map(p => [p.id, p])) }),
      processItem: async (inv, ctx) => {
        const product = ctx.products.get(inv.product_id);
        if (!product) return;
        const result = await d.processMaturity(db, inv, product);
        if (result.processed) await raise({ severity: 'INFO', message: `Investment matured — ${result.action} (${inv.coop_id})`, context: { coop_id: inv.coop_id, member_investment_id: inv.id, action: result.action } });
      } },
  ];
}

/**
 * Runs every batched pass inside one shared time budget, sharing it out FAIRLY: each pass gets an equal share of
 * whatever time is left, and time a pass does not need flows on to those after it - so no pass can starve the ones
 * behind it, which is what would otherwise have happened to the money-moving passes at the end of the old job.
 *
 * @param {object} o
 * @param {number} o.budgetMs         total time available for ALL passes
 * @param {(alert:{severity,message,context}) => Promise<void>} [o.onAlert]
 * @param {() => Date} [o.now]        injectable for tests
 * @param {() => number} [o.clock]    injectable for tests (drives the time budget)
 * @param {object} [o.deps]           injectable for tests
 */
async function runBatchedPasses(db, { budgetMs, onAlert = async () => {}, now = () => new Date(), clock = Date.now, deps = {}, pageSize = 200, log = console, only = null } = {}) {
  const d = { ...defaultDeps(), ...deps };
  const store = createJobStateStore(db, { now });
  const runNow = now();
  let passes = buildPasses(db, runNow, d, onAlert, log);
  if (only) passes = passes.filter(p => only.includes(p.key));
  const budget = new TimeBudget(budgetMs, { now: clock });

  const results = [];
  for (let i = 0; i < passes.length; i++) {
    const p = passes[i];
    results.push(await runBatchedPass({ key: p.key, store, budget: budget.slice(1 / (passes.length - i)), pageSize, fetchPage: p.fetchPage, prepare: p.prepare, processItem: p.processItem, cursorOf: p.cursorOf, now, log }));
    if (p.finalize) await p.finalize();
  }

  for (const p of passes) {
    await checkPassLag({ key: p.key, store, maxCycleHours: MAX_CYCLE_HOURS, now, alert: a => onAlert({
      severity: 'WARNING',
      message: `Nightly pass "${a.key}" has not completed a full cycle in ${a.hours}h (expected within ${a.maxCycleHours}h) - it is falling behind its time budget`,
      context: a }) });
  }
  return results;
}

module.exports = { runBatchedPasses, buildPasses, MAX_CYCLE_HOURS };
