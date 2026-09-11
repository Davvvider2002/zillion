/**
 * zillion/backend/lib/coopSavingsInterest.js
 *
 * Interest accrual for savings plans linked to an interest-bearing
 * savings package. Unlike loan interest (which is income to the
 * society), savings interest runs the OPPOSITE direction - it's an
 * EXPENSE the society pays out to the member, crediting their savings
 * balance in return. Applied at most once per calendar month per
 * plan, checked by looking for an existing interest_credit
 * transaction already recorded this month, rather than a separate
 * "last accrued" timestamp column - the transaction log itself is the
 * single source of truth for what's already been credited, matching
 * this project's established "never a separately-stored figure that
 * could drift" philosophy.
 */
'use strict';

const { accountingIsReady, getAccounts, postEntry } = require('./coopAccountingHelpers');

const INTEREST_EXPENSE_ACCOUNT_CODE = '5300';
const MEMBER_SAVINGS_PAYABLE_ACCOUNT_CODE = '2000';

/**
 * Sums every transaction recorded against a savings plan. Interest
 * credits are just another coop_savings_transactions row (source =
 * 'interest_credit'), so once credited they're automatically part of
 * the balance everywhere it's already computed this same way -
 * nothing else needs to change to make interest "show up".
 */
async function computeSavingsPlanBalance(db, savingsPlanId) {
  const { data: transactions } = await db.from('coop_savings_transactions').select('amount_kobo').eq('savings_plan_id', savingsPlanId);
  return (transactions || []).reduce((sum, t) => sum + t.amount_kobo, 0);
}

/**
 * Checks whether interest has already been credited to this plan
 * within the current calendar month.
 */
async function hasInterestBeenCreditedThisMonth(db, savingsPlanId, now) {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const { data: existing } = await db.from('coop_savings_transactions')
    .select('id').eq('savings_plan_id', savingsPlanId).eq('source', 'interest_credit')
    .gte('recorded_at', monthStart).limit(1);
  return !!(existing && existing.length);
}

/**
 * Applies one month's interest credit to a single savings plan, if
 * eligible (linked to an active package, meets any minimum balance,
 * not already credited this month, and the computed interest is
 * actually greater than zero). Posts the real accounting entry
 * (Interest Expense debited, Member Savings Payable credited) when
 * the society has Accounting set up - non-fatal if not, matching the
 * pattern used everywhere else in this project.
 *
 * @returns {Promise<{applied: boolean, reason?: string, amountKobo?: number}>}
 */
async function applyMonthlyInterestIfEligible(db, plan, pkg, now) {
  if (!pkg || !pkg.active) return { applied: false, reason: 'no_active_package' };

  const alreadyCredited = await hasInterestBeenCreditedThisMonth(db, plan.id, now);
  if (alreadyCredited) return { applied: false, reason: 'already_credited_this_month' };

  const balanceKobo = await computeSavingsPlanBalance(db, plan.id);
  if (pkg.min_balance_kobo && balanceKobo < pkg.min_balance_kobo) return { applied: false, reason: 'below_minimum_balance' };

  const interestKobo = Math.round(balanceKobo * (pkg.monthly_interest_rate_percent / 100));
  if (interestKobo <= 0) return { applied: false, reason: 'zero_interest' };

  const { error: insertErr } = await db.from('coop_savings_transactions').insert({
    coop_id: plan.coop_id,
    member_id: plan.member_id,
    savings_plan_id: plan.id,
    amount_kobo: interestKobo,
    source: 'interest_credit',
    reference: `Monthly interest — ${pkg.name}`,
    recorded_by: 'system:scheduled-reconcile',
  });
  if (insertErr) return { applied: false, reason: 'insert_failed' };

  try {
    if (await accountingIsReady(db, plan.coop_id)) {
      const accounts = await getAccounts(db, plan.coop_id, [INTEREST_EXPENSE_ACCOUNT_CODE, MEMBER_SAVINGS_PAYABLE_ACCOUNT_CODE]);
      const expense = accounts[INTEREST_EXPENSE_ACCOUNT_CODE];
      const payable = accounts[MEMBER_SAVINGS_PAYABLE_ACCOUNT_CODE];
      if (expense && payable) {
        await postEntry(db, plan.coop_id, `Savings interest credited — ${pkg.name}`, 'system:scheduled-reconcile', expense, payable, interestKobo);
      }
    }
  } catch (e) {
    console.error('[coopSavingsInterest] accounting post failed (non-fatal):', e.message);
  }

  return { applied: true, amountKobo: interestKobo };
}

module.exports = { computeSavingsPlanBalance, hasInterestBeenCreditedThisMonth, applyMonthlyInterestIfEligible };
