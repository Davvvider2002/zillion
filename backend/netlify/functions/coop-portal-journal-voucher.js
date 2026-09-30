/**
 * zillion/backend/netlify/functions/coop-portal-journal-voucher.js
 *
 * POST /api/v1/coop-portal-journal-voucher
 * Body: { member_id, total_amount_kobo, source, reference?, legs: [{ type, amount_kobo, target_id? }] }
 *
 * Splits one lump-sum payment from a member across multiple categories in a single action — the example
 * that prompted this: a member wires ₦100,000 to the society's bank account, and it needs to become
 * ₦50,000 savings + ₦20,000 dues + ₦30,000 loan repayment, each showing up correctly in that member's own
 * balances, not just as an abstract balanced journal entry.
 *
 * Deliberately does NOT let the caller pick raw chart-of-accounts lines the way coop-portal-journal-entry.js
 * does (that tool already exists, for genuine GL-only adjustments) - every leg here is one of the same five
 * categories a standalone payment already supports (savings, dues, loan_repayment, shares, investment), and
 * each leg is recorded through the EXACT SAME logic its own single-purpose endpoint uses
 * (coop-portal-record-savings-payment.js etc.) - same table inserts, same journal postings, same loan
 * completion checks, same investment-addon gate and unit-price arithmetic. The only difference is one shared
 * reference and one shared "this all came from the same ₦100,000" record (coop_journal_vouchers /
 * coop_journal_voucher_legs) tying the pieces together afterward.
 *
 * All legs are validated BEFORE any of them are recorded - wrong account, wrong status, an amount exceeding
 * what's owed on a loan, or legs that don't sum to the stated total are all caught up front, so a mistake on
 * leg 3 never leaves legs 1 and 2 already posted with no way back. Execution after that point is sequential,
 * not a database transaction (this codebase doesn't wrap multi-table writes that way anywhere) - a failure
 * during execution itself (a rare infrastructure fault, not a validation problem) is reported with exactly
 * which legs did and didn't post, never swallowed.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');
const { auditLog } = require('../../lib/auditLog');
const { recordSavingsPaymentJournalEntry, recordSharePaymentJournalEntry, alertIfNotBooked } = require('../../lib/coopMemberPaymentAccounting');
const { recordDuesPaymentJournalEntry } = require('../../lib/coopDuesAccounting');
const { recordLoanRepaymentJournalEntry, computeLoanRepaymentSplitUnified } = require('../../lib/coopLoanAccounting');
const { computeTotalRemainingKobo, finalizeLoanIfFullyRepaid } = require('../../lib/coopLoanCompletion');
const { accountingIsReady, getAccounts, postEntry } = require('../../lib/coopAccountingHelpers');
const { hasAddon } = require('../../lib/coopEntitlements');

const VALID_SOURCES = ['bank_transfer_manual', 'cash_in_person'];
const LEG_TYPES = ['savings', 'dues', 'loan_repayment', 'shares', 'investment'];
const CASH = '1000', BANK = '1010', SHARE_CAPITAL = '3000', MEMBER_INVESTMENT_PAYABLE = '2210';
const PERMISSION_FOR_LEG = { savings: ['savings', 'create'], dues: ['dues', 'create'], loan_repayment: ['loans', 'edit'], shares: ['members', 'create'], investment: ['investment', 'create'] };

const fmtNaira = kobo => '₦' + (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const memberId = (body.member_id || '').trim();
  const totalAmountKobo = Number.isInteger(body.total_amount_kobo) ? body.total_amount_kobo : 0;
  const reference = (body.reference || '').trim() || null;
  const source = VALID_SOURCES.includes(body.source) ? body.source : 'bank_transfer_manual';
  const legsInput = Array.isArray(body.legs) ? body.legs : [];

  if (!memberId) return err(400, 'member_id is required');
  if (totalAmountKobo <= 0) return err(400, 'total_amount_kobo must be a positive integer');
  if (source === 'cash_in_person' && !reference) return err(400, 'A reference (receipt number, etc.) is required when recording a cash payment.');
  if (legsInput.length < 1) return err(400, 'At least one leg is required — a voucher with nothing to split isn\'t one');

  // Every leg's own permission, checked up front - a caller without loan-edit access can't sneak a
  // loan_repayment leg into an otherwise-savings voucher.
  const legTypesUsed = [...new Set(legsInput.map(l => l.type))];
  for (const t of legTypesUsed) {
    if (!LEG_TYPES.includes(t)) return err(400, `Unknown leg type "${t}" — must be one of: ${LEG_TYPES.join(', ')}`);
    const [domain, action] = PERMISSION_FOR_LEG[t];
    if (!(await requirePortalPermission(db, auth, domain, action))) {
      return err(403, `You do not have access to record ${t.replace('_', ' ')} — ask your society admin to grant it.`);
    }
  }

  const { data: member } = await db.from('coop_members').select('id, coop_id, status, name').eq('id', memberId).maybeSingle();
  if (!member) return err(404, 'Member not found');
  if (member.coop_id !== coopId) return err(403, 'This member does not belong to your society.');
  if (member.status !== 'ACTIVE') return err(409, `This member's status is ${member.status}, not ACTIVE`);

  // Validate every leg's shape and target BEFORE recording anything.
  const legsSum = legsInput.reduce((s, l) => s + (Number.isInteger(l.amount_kobo) ? l.amount_kobo : 0), 0);
  if (legsSum !== totalAmountKobo) {
    return err(400, `The legs total ${fmtNaira(legsSum)}, which doesn't match the stated ${fmtNaira(totalAmountKobo)} — they must add up exactly.`);
  }

  const preparedLegs = [];
  for (const leg of legsInput) {
    const amountKobo = leg.amount_kobo;
    if (!Number.isInteger(amountKobo) || amountKobo <= 0) return err(400, `Every leg needs a positive amount (found one on a "${leg.type}" leg)`);

    if (leg.type === 'savings') {
      const planId = (leg.target_id || '').trim();
      if (!planId) return err(400, 'A savings leg needs target_id (the savings_plan_id)');
      const { data: plan } = await db.from('coop_savings_plans').select('id, coop_id, member_id, status').eq('id', planId).maybeSingle();
      if (!plan) return err(404, `Savings plan not found for one of the legs`);
      if (plan.coop_id !== coopId) return err(403, 'That savings plan does not belong to your society.');
      if (plan.member_id !== memberId) return err(400, 'That savings plan does not belong to the selected member.');
      if (plan.status !== 'ACTIVE') return err(409, `That savings plan is ${plan.status}, not ACTIVE`);
      preparedLegs.push({ type: 'savings', amountKobo, planId });
    } else if (leg.type === 'loan_repayment') {
      const loanId = (leg.target_id || '').trim();
      if (!loanId) return err(400, 'A loan repayment leg needs target_id (the loan_id)');
      const { data: loan } = await db.from('coop_loans')
        .select('id, coop_id, member_id, status, principal_kobo, interest_kobo, total_repayable_kobo, interest_method').eq('id', loanId).maybeSingle();
      if (!loan) return err(404, 'Loan not found for one of the legs');
      if (loan.coop_id !== coopId) return err(403, 'That loan does not belong to your society.');
      if (loan.member_id !== memberId) return err(400, 'That loan does not belong to the selected member.');
      if (!['DISBURSED', 'REPAYING'].includes(loan.status)) return err(409, `That loan is ${loan.status}, not eligible for repayment`);

      const { data: society } = await db.from('coop_societies').select('late_fee_type, late_fee_value, loan_late_fee_type, loan_late_fee_value').eq('coop_id', coopId).maybeSingle();
      const remainingKobo = await computeTotalRemainingKobo(db, loan, society || {});
      if (remainingKobo <= 0) return err(409, 'That loan has nothing left to repay.');
      if (amountKobo > remainingKobo) return err(400, `The loan repayment leg (${fmtNaira(amountKobo)}) is more than the ${fmtNaira(remainingKobo)} still owed on that loan.`);
      preparedLegs.push({ type: 'loan_repayment', amountKobo, loan, society: society || {} });
    } else if (leg.type === 'investment') {
      if (!(await hasAddon(db, coopId, 'investment'))) return err(403, 'Investment is not enabled for this society — add it from the Add-ons tab before splitting a payment into it.');
      const productId = (leg.target_id || '').trim();
      if (!productId) return err(400, 'An investment leg needs target_id (the product_id)');
      const { data: product } = await db.from('coop_investment_products').select('*').eq('id', productId).eq('coop_id', coopId).eq('active', true).maybeSingle();
      if (!product) return err(404, 'Investment product not found or not active for one of the legs');
      if (amountKobo % product.unit_price_kobo !== 0) {
        return err(400, `The investment leg (${fmtNaira(amountKobo)}) isn't an exact multiple of ${product.name}'s unit price (${fmtNaira(product.unit_price_kobo)}) — adjust it to a whole number of units.`);
      }
      const units = amountKobo / product.unit_price_kobo;
      if (product.product_type === 'general') {
        const unitsRemaining = product.total_units - product.units_sold;
        if (units > unitsRemaining) return err(400, `Only ${unitsRemaining} unit(s) remain available in ${product.name} — the investment leg asks for ${units}.`);
      }
      preparedLegs.push({ type: 'investment', amountKobo, product, units });

    } else if (leg.type === 'dues' || leg.type === 'shares') {
      preparedLegs.push({ type: leg.type, amountKobo });
    }
  }

  // Everything validated - now actually record each leg, in order, using the exact same logic each leg
  // type's own standalone endpoint uses.
  const actor = `portal:${auth.payload.merchant_id}`;
  const memberRef = { id: member.id, name: member.name };
  const legResults = [];

  try {
    for (const leg of preparedLegs) {
      if (leg.type === 'savings') {
        const { data: created, error } = await db.from('coop_savings_transactions').insert({
          coop_id: coopId, member_id: memberId, savings_plan_id: leg.planId, amount_kobo: leg.amountKobo, source, reference, recorded_by: actor,
        }).select().single();
        if (error) throw new Error(`Savings leg failed: ${error.message}`);
        const posted = await recordSavingsPaymentJournalEntry(db, coopId, leg.amountKobo, source, actor, memberRef, reference);
        await alertIfNotBooked(db, posted, { source: 'coop-portal-journal-voucher', what: 'A voucher savings leg', amountKobo: leg.amountKobo });
        legResults.push({ leg_type: 'savings', amount_kobo: leg.amountKobo, target_id: leg.planId, resulting_table: 'coop_savings_transactions', resulting_transaction_id: created.id });

      } else if (leg.type === 'dues') {
        const { data: created, error } = await db.from('coop_dues_transactions').insert({
          coop_id: coopId, member_id: memberId, amount_kobo: leg.amountKobo, source, reference, recorded_by: actor,
        }).select().single();
        if (error) throw new Error(`Dues leg failed: ${error.message}`);
        await recordDuesPaymentJournalEntry(db, coopId, leg.amountKobo, source, actor, memberRef);
        legResults.push({ leg_type: 'dues', amount_kobo: leg.amountKobo, target_id: null, resulting_table: 'coop_dues_transactions', resulting_transaction_id: created.id });

      } else if (leg.type === 'loan_repayment') {
        const { principalPortionKobo, interestPortionKobo } = await computeLoanRepaymentSplitUnified(db, leg.loan, leg.amountKobo);
        const { data: created, error } = await db.from('coop_loan_repayments').insert({
          loan_id: leg.loan.id, amount_kobo: leg.amountKobo, source, reference, recorded_by: actor,
          principal_portion_kobo: principalPortionKobo, interest_portion_kobo: interestPortionKobo,
        }).select().single();
        if (error) throw new Error(`Loan repayment leg failed: ${error.message}`);
        await recordLoanRepaymentJournalEntry(db, coopId, leg.amountKobo, source, actor, principalPortionKobo, interestPortionKobo, memberRef);
        const { completed } = await finalizeLoanIfFullyRepaid(db, leg.loan, leg.society);
        if (!completed && leg.loan.status === 'DISBURSED') await db.from('coop_loans').update({ status: 'REPAYING' }).eq('id', leg.loan.id);
        legResults.push({ leg_type: 'loan_repayment', amount_kobo: leg.amountKobo, target_id: leg.loan.id, resulting_table: 'coop_loan_repayments', resulting_transaction_id: created.id, loan_completed: completed });

      } else if (leg.type === 'investment') {
        const purchasedAt = new Date();
        const maturityDate = new Date(purchasedAt);
        maturityDate.setMonth(maturityDate.getMonth() + leg.product.tenure_months);
        const { data: created, error } = await db.from('coop_member_investments').insert({
          coop_id: coopId, member_id: memberId, product_id: leg.product.id, units_purchased: leg.units, principal_kobo: leg.amountKobo,
          maturity_date: maturityDate.toISOString().slice(0, 10), auto_reinvest: false,
        }).select().single();
        if (error) throw new Error(`Investment leg failed: ${error.message}`);
        await db.from('coop_investment_products').update({ units_sold: leg.product.units_sold + leg.units }).eq('id', leg.product.id);
        try {
          if (await accountingIsReady(db, coopId)) {
            const accounts = await getAccounts(db, coopId, [BANK, MEMBER_INVESTMENT_PAYABLE]);
            if (accounts[BANK] && accounts[MEMBER_INVESTMENT_PAYABLE]) {
              await postEntry(db, coopId, `Investment purchase — ${leg.product.name} — ${member.name || memberId} (voucher)`, actor, accounts[BANK], accounts[MEMBER_INVESTMENT_PAYABLE], leg.amountKobo);
            }
          }
        } catch (e) { console.error('[coop-portal-journal-voucher] investment leg ledger post failed (non-fatal):', e.message); }
        legResults.push({ leg_type: 'investment', amount_kobo: leg.amountKobo, target_id: leg.product.id, resulting_table: 'coop_member_investments', resulting_transaction_id: created.id, units_purchased: leg.units });

      } else if (leg.type === 'shares') {
        const { data: created, error } = await db.from('coop_share_transactions').insert({
          coop_id: coopId, member_id: memberId, amount_kobo: leg.amountKobo, source, reference, recorded_by: actor,
        }).select().single();
        if (error) throw new Error(`Shares leg failed: ${error.message}`);
        try {
          if (await accountingIsReady(db, coopId)) {
            const debitCode = source === 'cash_in_person' ? CASH : BANK;
            const accounts = await getAccounts(db, coopId, [debitCode, SHARE_CAPITAL]);
            if (accounts[debitCode] && accounts[SHARE_CAPITAL]) {
              await postEntry(db, coopId, `Share capital contribution — ${member.name || memberId} (voucher)`, actor, accounts[debitCode], accounts[SHARE_CAPITAL], leg.amountKobo);
            }
          }
        } catch (e) { console.error('[coop-portal-journal-voucher] shares leg ledger post failed (non-fatal):', e.message); }
        legResults.push({ leg_type: 'shares', amount_kobo: leg.amountKobo, target_id: null, resulting_table: 'coop_share_transactions', resulting_transaction_id: created.id });
      }
    }
  } catch (e) {
    // A leg genuinely failed mid-execution (rare - infrastructure, not validation, since validation already
    // passed). Whatever already posted is real and stays; report exactly what happened rather than pretending
    // the whole voucher failed cleanly.
    return err(500, `${e.message}. ${legResults.length} of ${preparedLegs.length} leg(s) were recorded before this failure — check the member's account before retrying the remainder.`);
  }

  const { data: voucher, error: voucherErr } = await db.from('coop_journal_vouchers').insert({
    coop_id: coopId, member_id: memberId, total_amount_kobo: totalAmountKobo, source, reference, created_by: actor,
  }).select().single();

  if (!voucherErr && voucher) {
    await db.from('coop_journal_voucher_legs').insert(
      legResults.map(l => ({ voucher_id: voucher.id, coop_id: coopId, leg_type: l.leg_type, amount_kobo: l.amount_kobo, target_id: l.target_id, resulting_table: l.resulting_table, resulting_transaction_id: l.resulting_transaction_id }))
    );
  }
  // A failure here is non-fatal — every leg already posted correctly above (the member's balances and the
  // ledger are already right); only the voucher's own audit-trail grouping would be missing.

  await auditLog(db, {
    action: 'COOP_PORTAL_JOURNAL_VOUCHER_RECORDED', username: auth.payload.merchant_id, role: 'merchant',
    ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_journal_voucher', resourceId: voucher ? voucher.id : null, requestBody: body, result: 'SUCCESS',
  });

  return ok({ success: true, voucher_id: voucher ? voucher.id : null, legs: legResults });
};
