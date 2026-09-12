/**
 * zillion/backend/lib/coopInvestmentLifecycle.js
 *
 * Runs the actual lifecycle of a member's investment on top of the
 * pure math in coopInvestmentAccrual.js: monthly accrual for
 * fixed-return products (checked against the transaction log itself,
 * same "no separately-stored last-accrued date" philosophy as
 * savings interest), maturity processing (payout or auto-reinvest),
 * and early withdrawal with penalty.
 *
 * Variable-return products are NOT accrued on a schedule here - their
 * returns come from an admin recording the venture's real performance
 * (see coop-portal-investment-performance.js), which is a distinct,
 * manually-triggered event, not something that happens automatically
 * every month regardless of whether the venture actually did anything.
 */
'use strict';

const { accountingIsReady, getAccounts, postEntry } = require('./coopAccountingHelpers');
const { computeFixedMonthlyAccrual, computeEarlyWithdrawalPenalty } = require('./coopInvestmentAccrual');

const INVESTMENT_RETURN_EXPENSE_CODE = '5310';
const MEMBER_INVESTMENT_PAYABLE_CODE = '2210';
const EARLY_WITHDRAWAL_PENALTY_INCOME_CODE = '4210';

async function hasAccrualBeenAppliedThisMonth(db, memberInvestmentId, now) {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const { data: existing } = await db.from('coop_investment_accruals')
    .select('id').eq('member_investment_id', memberInvestmentId).eq('reason', 'scheduled_accrual')
    .gte('accrued_at', monthStart).limit(1);
  return !!(existing && existing.length);
}

async function computeTotalScheduledAccrued(db, memberInvestmentId) {
  const { data: rows } = await db.from('coop_investment_accruals')
    .select('amount_kobo').eq('member_investment_id', memberInvestmentId).eq('reason', 'scheduled_accrual');
  return (rows || []).reduce((s, r) => s + r.amount_kobo, 0);
}

/** Sums every accrual of any kind - what the member is actually owed beyond their principal right now. */
async function computeTotalAccrued(db, memberInvestmentId) {
  const { data: rows } = await db.from('coop_investment_accruals').select('amount_kobo').eq('member_investment_id', memberInvestmentId);
  return (rows || []).reduce((s, r) => s + r.amount_kobo, 0);
}

async function postAccrualEntry(db, coopId, description, amountKobo) {
  try {
    if (await accountingIsReady(db, coopId)) {
      const accounts = await getAccounts(db, coopId, [INVESTMENT_RETURN_EXPENSE_CODE, MEMBER_INVESTMENT_PAYABLE_CODE]);
      const expense = accounts[INVESTMENT_RETURN_EXPENSE_CODE];
      const payable = accounts[MEMBER_INVESTMENT_PAYABLE_CODE];
      if (expense && payable) {
        await postEntry(db, coopId, description, 'system:scheduled-reconcile', expense, payable, amountKobo);
      }
    }
  } catch (e) {
    console.error('[coopInvestmentLifecycle] accounting post failed (non-fatal):', e.message);
  }
}

/**
 * Applies one month's accrual to a single fixed-return investment, if
 * eligible (still active, not already accrued this month, and the
 * computed amount is actually greater than zero).
 *
 * @returns {Promise<{applied: boolean, reason?: string, amountKobo?: number}>}
 */
async function applyMonthlyAccrualIfEligible(db, investment, product, now) {
  if (product.return_type !== 'fixed') return { applied: false, reason: 'not_fixed_return' };
  if (investment.status !== 'ACTIVE') return { applied: false, reason: 'not_active' };

  const alreadyApplied = await hasAccrualBeenAppliedThisMonth(db, investment.id, now);
  if (alreadyApplied) return { applied: false, reason: 'already_accrued_this_month' };

  const alreadyAccruedKobo = await computeTotalScheduledAccrued(db, investment.id);
  const accrualKobo = computeFixedMonthlyAccrual(
    investment.principal_kobo, product.fixed_return_rate_percent, product.tenure_months, alreadyAccruedKobo
  );
  if (accrualKobo <= 0) return { applied: false, reason: 'zero_accrual' };

  const { error: insertErr } = await db.from('coop_investment_accruals').insert({
    member_investment_id: investment.id, amount_kobo: accrualKobo, reason: 'scheduled_accrual',
  });
  if (insertErr) return { applied: false, reason: 'insert_failed' };

  await postAccrualEntry(db, investment.coop_id, `Investment accrual — ${product.name}`, accrualKobo);

  return { applied: true, amountKobo: accrualKobo };
}

/**
 * Processes a matured investment - auto-reinvests (principal + every
 * accrual rolled into a fresh investment cycle in the same product)
 * if the member opted in, otherwise simply marks it MATURED so an
 * admin can process the actual payout. Either way, the ledger keeps
 * the original amount owed exactly as-is - reinvesting creates a new
 * liability rather than erasing the old one.
 *
 * @returns {Promise<{processed: boolean, action?: 'reinvested'|'marked_matured', reason?: string}>}
 */
async function processMaturity(db, investment, product) {
  if (investment.status !== 'ACTIVE') return { processed: false, reason: 'not_active' };
  if (new Date(investment.maturity_date) > new Date()) return { processed: false, reason: 'not_yet_matured' };

  if (investment.auto_reinvest) {
    const totalAccruedKobo = await computeTotalAccrued(db, investment.id);
    const newPrincipalKobo = investment.principal_kobo + totalAccruedKobo;
    const newMaturityDate = new Date();
    newMaturityDate.setMonth(newMaturityDate.getMonth() + product.tenure_months);

    const { error: insertErr } = await db.from('coop_member_investments').insert({
      coop_id: investment.coop_id, member_id: investment.member_id, product_id: product.id,
      units_purchased: investment.units_purchased, principal_kobo: newPrincipalKobo,
      maturity_date: newMaturityDate.toISOString().slice(0, 10), auto_reinvest: true,
    });
    if (insertErr) return { processed: false, reason: 'reinvest_insert_failed' };

    await db.from('coop_member_investments').update({ status: 'REINVESTED', matured_at: new Date().toISOString() }).eq('id', investment.id);
    return { processed: true, action: 'reinvested' };
  }

  await db.from('coop_member_investments').update({ status: 'MATURED', matured_at: new Date().toISOString() }).eq('id', investment.id);
  return { processed: true, action: 'marked_matured' };
}

/**
 * Withdraws an ACTIVE investment before its maturity date, applying
 * the product's early withdrawal penalty (0 if the product doesn't
 * charge one) as a negative accrual - reduces what the member is owed
 * and is recognized as income to the society.
 *
 * @returns {Promise<{success: boolean, penaltyKobo?: number, error?: string}>}
 */
async function processEarlyWithdrawal(db, investment, product) {
  if (investment.status !== 'ACTIVE') return { success: false, error: 'This investment is not active' };
  if (new Date(investment.maturity_date) <= new Date()) return { success: false, error: 'This investment has already matured — use maturity processing instead' };

  const penaltyKobo = computeEarlyWithdrawalPenalty(investment.principal_kobo, product.early_withdrawal_penalty_percent || 0);

  if (penaltyKobo > 0) {
    await db.from('coop_investment_accruals').insert({
      member_investment_id: investment.id, amount_kobo: -penaltyKobo, reason: 'early_withdrawal_penalty',
    });
    try {
      if (await accountingIsReady(db, investment.coop_id)) {
        const accounts = await getAccounts(db, investment.coop_id, [MEMBER_INVESTMENT_PAYABLE_CODE, EARLY_WITHDRAWAL_PENALTY_INCOME_CODE]);
        const payable = accounts[MEMBER_INVESTMENT_PAYABLE_CODE];
        const penaltyIncome = accounts[EARLY_WITHDRAWAL_PENALTY_INCOME_CODE];
        if (payable && penaltyIncome) {
          await postEntry(db, investment.coop_id, `Early withdrawal penalty — ${product.name}`, 'system:early-withdrawal', payable, penaltyIncome, penaltyKobo);
        }
      }
    } catch (e) {
      console.error('[coopInvestmentLifecycle] penalty accounting post failed (non-fatal):', e.message);
    }
  }

  await db.from('coop_member_investments').update({ status: 'WITHDRAWN_EARLY', withdrawn_at: new Date().toISOString() }).eq('id', investment.id);

  return { success: true, penaltyKobo };
}

module.exports = {
  hasAccrualBeenAppliedThisMonth, computeTotalScheduledAccrued, computeTotalAccrued,
  applyMonthlyAccrualIfEligible, processMaturity, processEarlyWithdrawal,
};
