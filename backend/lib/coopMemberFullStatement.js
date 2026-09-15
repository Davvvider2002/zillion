/**
 * zillion/backend/lib/coopMemberFullStatement.js
 *
 * Builds one member's complete statement across every area they can
 * have activity in - loans, savings, investment, and dues - each as
 * its own section with the same level of detail the loan section
 * already had: a chronological list of actual events (never the
 * schedule, always what really happened) with a running balance
 * after each line.
 *
 * Loans: reuses computeMemberLoanStatement() directly rather than
 * duplicating that logic - this can never drift from what it already
 * computes.
 *
 * Savings: every coop_savings_transactions row (deposits AND interest
 * credits both live in the same table, distinguished by source) in
 * date order, running balance building up from zero.
 *
 * Investment: every coop_investment_accruals row (scheduled interest,
 * venture performance - which can be negative, a genuine loss - and
 * early withdrawal penalties, also negative) in date order, running
 * balance starting from the principal paid in.
 *
 * Dues: computeDuesOwing()'s existing year-by-year accrued/paid/owing
 * breakdown for the summary, plus the actual coop_dues_transactions
 * payments in date order underneath it.
 */
'use strict';

const { computeMemberLoanStatement } = require('./coopLoanStatement');
const { computeDuesOwing } = require('./coopDues');

async function buildSavingsSection(db, memberId) {
  const { data: plans } = await db.from('coop_savings_plans')
    .select('id, target_amount_kobo, monthly_contribution_kobo, status, start_date')
    .eq('member_id', memberId).order('start_date', { ascending: false });

  return Promise.all((plans || []).map(async (plan) => {
    const { data: txns } = await db.from('coop_savings_transactions')
      .select('amount_kobo, source, recorded_at').eq('savings_plan_id', plan.id).order('recorded_at', { ascending: true });

    let runningBalance = 0;
    const transactions = (txns || []).map(t => {
      runningBalance += t.amount_kobo;
      return {
        date: t.recorded_at,
        description: t.source === 'interest_credit' ? 'Interest credited' : `Deposit (${(t.source || 'manual').replace(/_/g, ' ')})`,
        debit_kobo: 0,
        credit_kobo: t.amount_kobo,
        balance_kobo: runningBalance,
      };
    });

    return { ...plan, transactions, saved_kobo: runningBalance };
  }));
}

async function buildInvestmentSection(db, memberId) {
  const { data: investments } = await db.from('coop_member_investments')
    .select('id, product_id, units_purchased, principal_kobo, purchased_at, maturity_date, status, coop_investment_products(name, return_type)')
    .eq('member_id', memberId).order('purchased_at', { ascending: false });

  return Promise.all((investments || []).map(async (inv) => {
    const { data: accruals } = await db.from('coop_investment_accruals')
      .select('amount_kobo, reason, accrued_at').eq('member_investment_id', inv.id).order('accrued_at', { ascending: true });

    let runningBalance = inv.principal_kobo;
    const transactions = [{
      date: inv.purchased_at,
      description: `Investment purchased — ${inv.coop_investment_products?.name || 'Product'}`,
      debit_kobo: 0,
      credit_kobo: inv.principal_kobo,
      balance_kobo: runningBalance,
    }];
    for (const a of (accruals || [])) {
      runningBalance += a.amount_kobo; // negative for a loss or an early-withdrawal penalty, adds naturally
      transactions.push({
        date: a.accrued_at,
        description: a.reason === 'scheduled_accrual' ? 'Interest accrued'
          : a.reason === 'venture_performance' ? (a.amount_kobo >= 0 ? 'Venture performance (gain)' : 'Venture performance (loss)')
          : a.reason === 'early_withdrawal_penalty' ? 'Early withdrawal penalty'
          : (a.reason || '').replace(/_/g, ' '),
        debit_kobo: a.amount_kobo < 0 ? -a.amount_kobo : 0,
        credit_kobo: a.amount_kobo > 0 ? a.amount_kobo : 0,
        balance_kobo: runningBalance,
      });
    }

    return {
      id: inv.id, product_name: inv.coop_investment_products?.name || 'Product', return_type: inv.coop_investment_products?.return_type,
      units_purchased: inv.units_purchased, principal_kobo: inv.principal_kobo, maturity_date: inv.maturity_date, status: inv.status,
      transactions, current_value_kobo: runningBalance,
    };
  }));
}

async function buildDuesSection(db, member, society) {
  const summary = await computeDuesOwing(db, member, society);
  const { data: payments } = await db.from('coop_dues_transactions')
    .select('amount_kobo, source, recorded_at').eq('member_id', member.id).order('recorded_at', { ascending: true });

  let runningPaid = 0;
  const transactions = (payments || []).map(p => {
    runningPaid += p.amount_kobo;
    return {
      date: p.recorded_at,
      description: `Dues payment (${(p.source || 'manual').replace(/_/g, ' ')})`,
      debit_kobo: 0,
      credit_kobo: p.amount_kobo,
      balance_kobo: runningPaid,
    };
  });

  return { summary, transactions };
}

/**
 * @param {object} db
 * @param {string} memberId
 * @returns {Promise<{member: object, loans: Array, savings: Array, investment: Array, dues: object}|null>}
 */
async function computeMemberFullStatement(db, memberId) {
  const loanStatement = await computeMemberLoanStatement(db, memberId);
  if (!loanStatement) return null;

  const { data: member } = await db.from('coop_members').select('id, coop_id, activated_at').eq('id', memberId).maybeSingle();
  const { data: society } = await db.from('coop_societies')
    .select('dues_amount_kobo, dues_frequency').eq('coop_id', member.coop_id).maybeSingle();

  const [savings, investment, dues] = await Promise.all([
    buildSavingsSection(db, memberId),
    buildInvestmentSection(db, memberId),
    buildDuesSection(db, member, society || {}),
  ]);

  return { member: loanStatement.member, loans: loanStatement.loans, savings, investment, dues };
}

module.exports = { computeMemberFullStatement };
