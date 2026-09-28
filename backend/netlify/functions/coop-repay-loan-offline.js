/**
 * zillion/backend/netlify/functions/coop-repay-loan-offline.js
 *
 * POST /api/v1/coop-repay-loan-offline
 *
 * Offline loan repayment - the member uses the EXISTING, already-proven wallet Send Zil flow (Bluetooth, NFC, or QR) to send Zil
 * directly to their society's merchant account. No new offline protocol was built; this reuses what already works.
 *
 * Because the transfer already happened via Zillion's own cryptographically-signed coin protocol before this endpoint is
 * called, verification here means confirming genuine coin_ledger entries exist - not re-verifying the cryptography. Each claim
 * consumes SPECIFIC ledger transfers exactly once (lib/coopOfflineTransfer.js; UNIQUE(ledger_entry_id) in the database): this
 * header used to say the residual risk was only a bookkeeping misattribution, but when one real transfer could back several
 * claims the society recorded more collections than it received and a loan closed early - a real loss.
 *
 * Auth: wallet JWT.
 * Body: { loan_id, amount_kobo?, transfer_entry_ids? }
 *   - neither amount nor ids  -> applies everything the member has sent and not yet applied ("apply what I just sent").
 *                                A client never has to know or type an exact amount. GET the options endpoint
 *                                (coop-offline-repay-options) first to show the member what will happen.
 *   - transfer_entry_ids       -> exactly those transfers.
 *   - amount_kobo              -> the transfers that add up to exactly that amount (the original interface, still supported).
 *   A mismatch returns 400 with available_transfers and suggested_amount_kobo, so even a naive client can recover in one step.
 *
 * OVER-PAYMENT: the loan is credited at most what it still owes. A transfer cannot be sent back (the coins have moved), so
 * the excess goes to the member's earliest ACTIVE savings plan; a member with no active plan (savings_plan_id is NOT NULL on
 * the savings ledger) has it HELD - posted to the ledger as owed to them, with a warning to the admin. Either way it is
 * recorded per transfer (applied_kobo / excess_kobo / excess_disposition), never silently over-credited to the loan.
 */
'use strict';

const { uniqueReference } = require('../../lib/coopReference');
const { logAlert } = require('../../lib/alerts');
const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { resolveMemberForZillionId } = require('../../lib/coopMemberResolve');
const { recordLoanRepaymentJournalEntry, computeLoanRepaymentSplitUnified } = require('../../lib/coopLoanAccounting');
const { settleLoanAfterRepayment, totalRemainingForLoan } = require('../../lib/coopLoanCompletion');
const { recordSavingsPaymentJournalEntry, alertIfNotBooked } = require('../../lib/coopMemberPaymentAccounting');
const T = require('../../lib/coopOfflineTransfer');

const SOURCE = 'coop-repay-loan-offline';
const naira = k => '₦' + (k / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c, m, extra) => ({ statusCode: c, headers: hdr, body: JSON.stringify({ error: m, ...(extra || {}) }) });
  const has = v => v !== undefined && v !== null;

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  const zillionId = auth.payload.zillion_id;
  if (!zillionId) return err(400, 'This wallet has no linked Zillion identity yet');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const loanId = (body.loan_id || '').trim();
  if (!loanId) return err(400, 'loan_id is required');
  let amountKobo, entryIds;
  if (has(body.amount_kobo)) {
    if (!Number.isInteger(body.amount_kobo) || body.amount_kobo <= 0) return err(400, 'amount_kobo must be a positive integer');
    amountKobo = body.amount_kobo;
  }
  if (has(body.transfer_entry_ids)) {
    if (!Array.isArray(body.transfer_entry_ids) || !body.transfer_entry_ids.length) return err(400, 'transfer_entry_ids must be a non-empty list');
    entryIds = body.transfer_entry_ids;
  }

  const db = getServiceClient();

  const member = await resolveMemberForZillionId(db, zillionId, 'id, coop_id, phone_normalized, name');
  if (!member) return err(404, 'No cooperative membership found for this wallet');

  const { data: loan } = await db.from('coop_loans').select('id, coop_id, status, principal_kobo, interest_kobo, total_repayable_kobo, interest_method').eq('id', loanId).eq('member_id', member.id).maybeSingle();
  if (!loan) return err(404, 'That loan does not belong to you');
  const windowStart = new Date(Date.now() - T.OFFLINE_WINDOW_MINUTES * 60 * 1000).toISOString();
  if (!['DISBURSED', 'REPAYING'].includes(loan.status)) {
    // The likeliest retry of all: the claim that CLEARED the loan succeeded but its response was lost, so the member tries again
    // and finds the loan COMPLETED. That is "already recorded", not an error.
    if (loan.status === 'COMPLETED') {
      let recent = []; try { recent = await T.recentClaimGroups(db, { memberId: member.id, loanId, windowStart }); } catch (_) { /* ordinary message below */ }
      if (recent.length) return ok({ success: true, already_processed: true, message: 'This repayment was already recorded.' });
    }
    return err(409, `This loan is ${loan.status}, not eligible for repayment`);
  }

  const holders = await T.getOfflineHolders(db, member);
  if (!holders) return err(409, 'Your society is not set up to receive offline transfers yet.');

  // Proof of funds: bind this claim to SPECIFIC ledger transfers, each usable once.
  let found;
  try { found = await T.getUnclaimedTransfers(db, { memberHash: holders.memberHash, merchantHash: holders.merchantHash, windowStart }); }
  catch (e) { return err(500, 'Could not check your transfers just now. Nothing has been recorded - please try again in a moment.'); }

  const pick = T.pickTransfers(found.unclaimed, { amountKobo, entryIds });
  if (pick.error) {
    if (pick.error === 'invalid_ids') return err(400, 'transfer_entry_ids must be positive whole numbers');
    if (pick.error === 'unavailable_ids') return err(409, 'One or more of those transfers is no longer available - it may already have been applied.', T.describeAvailable(found.unclaimed));
    // A retry of a claim that already went through (a lost response, a double tap) is not an error.
    let groups = [];
    try { groups = await T.recentClaimGroups(db, { memberId: member.id, loanId, windowStart }); } catch (_) { /* fall through to the ordinary message */ }
    const repeat = pick.error === 'none' ? groups.length > 0 : groups.some(g => g.totalKobo === amountKobo || g.appliedKobo === amountKobo);
    if (repeat) return ok({ success: true, already_processed: true, message: 'This repayment was already recorded.' });
    return err(400, T.describeShortfall(found, amountKobo, T.OFFLINE_WINDOW_MINUTES), T.describeAvailable(found.unclaimed));
  }

  // What the loan can actually take. The transfer has already happened and cannot be returned, but the loan must never be
  // credited more than it owes.
  let remainingKobo;
  try { remainingKobo = await totalRemainingForLoan(db, loan, member.coop_id); }
  catch (e) { return err(500, 'Could not work out what is owed on this loan just now. Nothing has been recorded - please try again.'); }
  if (remainingKobo <= 0) return err(409, 'This loan has nothing left to repay. Your transfer has not been used - contact your society admin.', T.describeAvailable(found.unclaimed));

  const plan = T.planApplication(pick.selection, remainingKobo);
  const excessPlan = plan.excessKobo > 0 ? await T.findExcessPlan(db, member.id) : null;
  const excessDisposition = plan.excessKobo > 0 ? (excessPlan ? 'savings' : 'held') : null;

  // Reserve first, then record. If anything below fails the reservation is released, so a transfer is never lost; if the
  // process dies in between, the money is merely held (a claim with no repayment), never double-credited.
  const reserved = await T.reserveTransferClaims(db, plan.rows, { coopId: member.coop_id, memberId: member.id, loanId, excessDisposition });
  if (!reserved.ok) {
    if (reserved.reason === 'already_claimed') return err(409, 'That transfer has just been applied to a repayment. If that was not you, contact your society admin.');
    return err(500, 'Could not reserve your transfer just now. Nothing has been recorded - please try again.');
  }
  const release = async (why) => {
    const r = await T.releaseTransferClaims(db, reserved.ids);
    if (!r.ok) await logAlert(db, { severity: 'CRITICAL', source: SOURCE,
      message: `An offline transfer was reserved for a loan repayment that then failed (${why}), and releasing the reservation ALSO failed. The transfer cannot be claimed again until its claim rows are cleared manually.`,
      context: { loan_id: loanId, member_id: member.id, claim_ids: reserved.ids } });
  };

  let principalPortionKobo, interestPortionKobo;
  try { ({ principalPortionKobo, interestPortionKobo } = await computeLoanRepaymentSplitUnified(db, loan, plan.applyKobo)); }
  catch (e) { await release('split calculation'); return err(500, 'Could not work out the repayment split just now. Your transfer has not been used up - please try again.'); }

  const { data: repayment, error: repayErr } = await db.from('coop_loan_repayments').insert({
    loan_id: loanId,
    amount_kobo: plan.applyKobo,
    source: 'offline_zil',
    reference: uniqueReference('Offline Zil transfer, verified via coin_ledger'),   // was one fixed sentence: only ONE offline repayment could ever be recorded platform-wide
    recorded_by: 'member:offline_zil',
    principal_portion_kobo: principalPortionKobo,
    interest_portion_kobo:  interestPortionKobo,
  }).select().single();

  if (repayErr) { await release(repayErr.message); return err(500, `Transfer verified but recording the repayment failed: ${repayErr.message}. Your transfer has not been used up - please try again.`); }
  await T.linkTransferClaims(db, reserved.ids, repayment.id);

  const { completed } = await settleLoanAfterRepayment(db, loan, member.coop_id);

  await recordLoanRepaymentJournalEntry(db, member.coop_id, plan.applyKobo, 'offline_zil', 'member:offline_zil', principalPortionKobo, interestPortionKobo, { id: member.id, name: member.name });

  // The excess. The transfer cannot be sent back, so it is credited to the member's savings; with no active plan there is
  // nowhere to credit it, so it is held. Either way the ledger records that the society owes it to the member.
  let excessCredited = false;
  if (plan.excessKobo > 0) {
    let reference = null;
    if (excessPlan) {
      const r = await T.creditExcessToSavings(db, { coopId: member.coop_id, memberId: member.id, planId: excessPlan.id, excessKobo: plan.excessKobo });
      excessCredited = r.ok; reference = r.reference;
      if (!r.ok) {
        await db.from('coop_offline_transfer_claims').update({ excess_disposition: 'held' }).in('id', reserved.ids);
        await logAlert(db, { severity: 'CRITICAL', source: SOURCE,
          message: `${naira(plan.excessKobo)} of an offline transfer exceeded what a loan owed and crediting the member's savings FAILED (${r.error}). The repayment was recorded and the transfer is spent; the excess must be credited manually.`,
          context: { loan_id: loanId, member_id: member.id, excess_kobo: plan.excessKobo } });
      }
    } else {
      await logAlert(db, { severity: 'WARNING', source: SOURCE,
        message: `${naira(plan.excessKobo)} of an offline transfer exceeded what a loan owed. The member has no active savings plan to credit, so it is HELD for them - create a plan for them or arrange a refund.`,
        context: { loan_id: loanId, member_id: member.id, coop_id: member.coop_id, excess_kobo: plan.excessKobo } });
    }
    const posted = await recordSavingsPaymentJournalEntry(db, member.coop_id, plan.excessKobo, 'offline_zil', 'member:offline_zil', { id: member.id, name: member.name }, reference || uniqueReference('Held excess from offline loan repayment'));
    await alertIfNotBooked(db, posted, { source: SOURCE, what: 'The excess from an offline loan repayment', amountKobo: plan.excessKobo });
  }

  let message = `${naira(plan.applyKobo)} confirmed and applied to your loan.`;
  if (completed) message += ' Your loan is now fully repaid.';
  if (plan.excessKobo > 0) message += excessCredited
    ? ` You sent ${naira(plan.excessKobo)} more than you owed, so it has been added to your savings.`
    : ` You sent ${naira(plan.excessKobo)} more than you owed. It is being held for you - your society admin will follow up.`;

  return ok({ success: true, repayment, message, loan_completed: completed, transfers_applied: pick.selection.length,
    applied_kobo: plan.applyKobo, excess_kobo: plan.excessKobo, excess_disposition: plan.excessKobo > 0 ? (excessCredited ? 'savings' : 'held') : null });
};
