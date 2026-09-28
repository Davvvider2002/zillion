/**
 * zillion/backend/netlify/functions/coop-flutterwave-checkout-verify.js
 *
 * POST /api/v1/coop-flutterwave-checkout-verify
 *
 * Called by the wallet when it loads with checkout_return=1 in its URL
 * (i.e. the member has just come back from Flutterwave's hosted
 * checkout page). Never trusts what the client claims happened —
 * looks up the actual session by tx_ref (created server-side in
 * coop-flutterwave-checkout-init.js) to know what amount/type was
 * really expected, then independently re-verifies the payment via
 * Flutterwave's own v3 verify API before crediting anything. Matches
 * the same principle applied to the Flutterwave webhook receiver.
 *
 * Idempotent — calling this twice for an already-completed session
 * (e.g. a page reload) is safe and doesn't double-credit.
 *
 * Auth: wallet JWT.
 * Body: { tx_ref, transaction_id }
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { resolveMemberForZillionId } = require('../../lib/coopMemberResolve');
const { calculateFees }    = require('../../lib/coopFees');
const { recordDuesPaymentJournalEntry } = require('../../lib/coopDuesAccounting');
const { accountingIsReady, getAccounts, postEntry } = require('../../lib/coopAccountingHelpers');
const { recordLoanRepaymentJournalEntry, computeLoanRepaymentSplitUnified } = require('../../lib/coopLoanAccounting');
const { settleLoanAfterRepayment } = require('../../lib/coopLoanCompletion');
const { recordSavingsPaymentJournalEntry, recordSharePaymentJournalEntry, alertIfNotBooked } = require('../../lib/coopMemberPaymentAccounting');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  const zillionId = auth.payload.zillion_id;
  if (!zillionId) return err(400, 'This wallet has no linked Zillion identity yet');

  const secretKey = (process.env.FLW_V3_SECRET_KEY || '').trim();
  if (!secretKey) return err(500, 'FLW_V3_SECRET_KEY not configured');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const txRef         = (body.tx_ref || '').trim();
  const transactionId  = (body.transaction_id || '').trim();
  if (!txRef)          return err(400, 'tx_ref is required');
  if (!transactionId)   return err(400, 'transaction_id is required');

  const db = getServiceClient();

  const member = await resolveMemberForZillionId(db, zillionId, 'id');
  if (!member) return err(404, 'No cooperative membership found for this wallet');

  const { data: session } = await db.from('coop_checkout_sessions').select('*').eq('tx_ref', txRef).maybeSingle();
  if (!session) return err(404, 'No matching checkout session found for this reference');
  if (session.member_id !== member.id) return err(403, 'This checkout session does not belong to you');

  if (session.status === 'completed') {
    return ok({ success: true, already_processed: true, message: 'This payment was already confirmed and credited.' });
  }

  // Mandatory per Flutterwave's own docs: verify server-side before
  // trusting anything the client (or the redirect URL) claims happened.
  let verifyData;
  try {
    const res = await fetch(`https://api.flutterwave.com/v3/transactions/${transactionId}/verify`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    verifyData = await res.json();
  } catch (e) {
    return err(502, `Failed to reach Flutterwave for verification: ${e.message}`);
  }

  const v = verifyData.data || {};
  // session.amount_kobo is the BASE (credited) amount — the customer
  // was actually charged base + both fees, re-derived here via the
  // same shared calculation used at checkout-init, never stored
  // separately.
  const { totalKobo } = calculateFees(session.amount_kobo);
  const verifiedOk = verifyData.status === 'success'
    && v.status === 'successful'
    && v.tx_ref === txRef
    && v.currency === 'NGN'
    && Number(v.amount) === totalKobo / 100;

  if (!verifiedOk) {
    await db.from('coop_checkout_sessions').update({ status: 'failed', flw_transaction_id: transactionId }).eq('tx_ref', txRef);
    return ok({ success: false, message: 'Payment could not be verified as successful.', _debug: v });
  }

  if (session.type === 'investment') {
    const { data: product } = await db.from('coop_investment_products').select('*').eq('id', session.product_id).maybeSingle();
    if (!product) {
      await db.from('coop_checkout_sessions').update({ status: 'completed', flw_transaction_id: transactionId }).eq('tx_ref', txRef);
      return ok({ success: false, message: `Payment confirmed but this product no longer exists. Contact support with reference ${txRef} for a refund.` });
    }

    // The authoritative capacity check - a real race exists between
    // two people buying the last unit(s) of a pooled product at the
    // same time, and only this check, right before crediting, can
    // decide who genuinely got in. The earlier check at init time was
    // only ever an early, honest rejection, never a guarantee.
    if (product.product_type === 'general' && session.units > (product.total_units - product.units_sold)) {
      await db.from('coop_checkout_sessions').update({ status: 'completed', flw_transaction_id: transactionId }).eq('tx_ref', txRef);
      return ok({ success: false, message: `Payment confirmed, but this product sold out before your payment cleared. Contact support with reference ${txRef} for a refund - your investment was not created.` });
    }

    const purchasedAt = new Date();
    const maturityDate = new Date(purchasedAt);
    maturityDate.setMonth(maturityDate.getMonth() + product.tenure_months);

    const { error: investErr } = await db.from('coop_member_investments').insert({
      coop_id: session.coop_id, member_id: session.member_id, product_id: session.product_id,
      units_purchased: session.units, principal_kobo: session.amount_kobo,
      maturity_date: maturityDate.toISOString().slice(0, 10), checkout_reference: txRef,
    });
    if (investErr) {
      if (investErr.code === '23505') {
        await db.from('coop_checkout_sessions').update({ status: 'completed', flw_transaction_id: transactionId }).eq('tx_ref', txRef);
        return ok({ success: true, already_processed: true });
      }
      return err(500, `Payment verified but your investment could not be recorded: ${investErr.message}. Contact support with reference ${txRef}.`);
    }

    await db.from('coop_investment_products').update({ units_sold: product.units_sold + session.units }).eq('id', session.product_id);
    await db.from('coop_checkout_sessions').update({ status: 'completed', flw_transaction_id: transactionId }).eq('tx_ref', txRef);

    try {
      if (await accountingIsReady(db, session.coop_id)) {
        const accounts = await getAccounts(db, session.coop_id, ['1010', '2210']);
        const bank = accounts['1010'];
        const investmentPayable = accounts['2210'];
        if (bank && investmentPayable) {
          const { data: memberRow } = await db.from('coop_members').select('name').eq('id', session.member_id).maybeSingle();
          const memberLabel = memberRow?.name ? `${memberRow.name} (Member #${String(session.member_id).slice(0, 8)})` : `Member #${String(session.member_id).slice(0, 8)}`;
          await postEntry(db, session.coop_id, `Investment purchase — ${product.name} — ${memberLabel}`, `checkout:flutterwave_v3`, bank, investmentPayable, session.amount_kobo);
        }
      }
    } catch (e) {
      console.error('[coop-flutterwave-checkout-verify] accounting post failed (non-fatal):', e.message);
    }

    return ok({
      success: true, type: 'investment', amount_kobo: session.amount_kobo, units: session.units,
      message: `Payment confirmed — ${session.units} unit(s) of ${product.name} purchased for ₦${(session.amount_kobo / 100).toLocaleString()}.`,
    });
  }

  // Loan repayments need what the other repayment paths already record: the
  // principal/interest split, a journal entry, and the loan's status. This path
  // used to insert a bare row - so an online repayment never reduced principal or
  // interest outstanding, never reached the ledger, and never moved a loan out of
  // DISBURSED. Checked against the loan itself, never the client's word.
  let loanCtx = null;
  let splitPortions = {};
  if (session.type === 'loan_repayment') {
    const { data: loan } = await db.from('coop_loans')
      .select('id, coop_id, member_id, status, principal_kobo, interest_kobo, total_repayable_kobo, interest_method')
      .eq('id', session.loan_id).maybeSingle();
    if (!loan || loan.member_id !== session.member_id || !['DISBURSED', 'REPAYING'].includes(loan.status)) {
      // The payment is real and already taken, but there is nothing open to apply it to
      // (for instance the loan was fully repaid in the meantime). Record nothing rather
      // than distort the books; say so honestly, with the reference needed to resolve it.
      await db.from('coop_checkout_sessions').update({ status: 'completed', flw_transaction_id: transactionId }).eq('tx_ref', txRef);
      return ok({ success: false, message: `Payment confirmed, but this loan is no longer open for repayment (it may already be fully repaid). Contact support with reference ${txRef} so the payment can be applied or refunded.` });
    }
    loanCtx = loan;
    const split = await computeLoanRepaymentSplitUnified(db, loan, session.amount_kobo);
    splitPortions = { principal_portion_kobo: split.principalPortionKobo, interest_portion_kobo: split.interestPortionKobo };
  }

  // Credit the correct ledger — session.type/amount/member_id/coop_id
  // came from OUR OWN record of what this tx_ref was created for, never
  // from anything the client just sent.
  const LEDGER_TABLES = { savings: 'coop_savings_transactions', dues: 'coop_dues_transactions', loan_repayment: 'coop_loan_repayments', share_capital: 'coop_share_transactions' };
  const ledgerTable = LEDGER_TABLES[session.type];
  const insertRow = session.type === 'loan_repayment'
    ? { loan_id: session.loan_id, amount_kobo: session.amount_kobo, source: 'flutterwave_checkout', reference: txRef, recorded_by: 'checkout:flutterwave_v3', ...splitPortions }
    : { coop_id: session.coop_id, member_id: session.member_id, amount_kobo: session.amount_kobo, source: 'flutterwave_checkout', reference: txRef, recorded_by: 'checkout:flutterwave_v3' };
  if (session.type === 'savings') insertRow.savings_plan_id = session.savings_plan_id;

  const { error: creditErr } = await db.from(ledgerTable).insert(insertRow);
  if (creditErr) {
    // Unique index on reference (both ledgers have this — savings from
    // the earlier webhook work, dues added specifically for this)
    // means this specific payment was already credited — treat as
    // success, not failure.
    if (creditErr.code === '23505') {
      await db.from('coop_checkout_sessions').update({ status: 'completed', flw_transaction_id: transactionId }).eq('tx_ref', txRef);
      return ok({ success: true, already_processed: true });
    }
    return err(500, `Payment verified but crediting failed: ${creditErr.message}. Contact support with reference ${txRef}.`);
  }

  await db.from('coop_checkout_sessions').update({ status: 'completed', flw_transaction_id: transactionId }).eq('tx_ref', txRef);

  let loanCompleted = false;
  if (session.type === 'loan_repayment') {
    const { data: borrower } = await db.from('coop_members').select('id, name').eq('id', session.member_id).maybeSingle();
    await recordLoanRepaymentJournalEntry(db, session.coop_id, session.amount_kobo, 'flutterwave_checkout', 'checkout:flutterwave_v3',
      splitPortions.principal_portion_kobo, splitPortions.interest_portion_kobo, borrower ? { id: borrower.id, name: borrower.name } : null);
    ({ completed: loanCompleted } = await settleLoanAfterRepayment(db, loanCtx, session.coop_id));
  }

  // Savings deposits and share purchases paid online used to be credited to the member with
  // no ledger entry at all (dues and loan repayments already posted one).
  if (session.type === 'savings' || session.type === 'share_capital') {
    const { data: payer } = await db.from('coop_members').select('id, name').eq('id', session.member_id).maybeSingle();
    const record = session.type === 'savings' ? recordSavingsPaymentJournalEntry : recordSharePaymentJournalEntry;
    const posted = await record(db, session.coop_id, session.amount_kobo, 'flutterwave_checkout', 'checkout:flutterwave_v3', payer, txRef);
    await alertIfNotBooked(db, posted, { source: 'coop-flutterwave-checkout-verify', what: `Online ${session.type === 'savings' ? 'savings' : 'share capital'} payment ${txRef}`, amountKobo: session.amount_kobo });
  }

  if (session.type === 'dues') {
    const { data: duesMember } = await db.from('coop_members').select('id, name').eq('id', session.member_id).maybeSingle();
    await recordDuesPaymentJournalEntry(db, session.coop_id, session.amount_kobo, 'flutterwave_checkout', 'checkout:flutterwave_v3', duesMember ? { id: duesMember.id, name: duesMember.name } : null);
  }

  return ok({
    success: true,
    type: session.type,
    amount_kobo: session.amount_kobo,
    loan_completed: loanCompleted,
    message: `Payment confirmed — ₦${(session.amount_kobo / 100).toLocaleString()} credited to your ${{ savings: 'savings', dues: 'dues', loan_repayment: 'loan repayment', share_capital: 'share capital' }[session.type]}.` + (loanCompleted ? ' Your loan is now fully repaid.' : ''),
  });
};
