/**
 * zillion/backend/netlify/functions/coop-repay-loan-offline.js
 *
 * POST /api/v1/coop-repay-loan-offline
 *
 * Offline loan repayment — the member uses the EXISTING, already-
 * proven wallet Send Zil flow (Bluetooth, NFC, or QR) to send Zil
 * directly to their society's merchant account, exactly the same
 * mechanism already used and proven for offline P2P transfers this
 * whole session. No new offline protocol was built — this reuses what
 * already works.
 *
 * Because the actual transfer already happened via Zillion's own
 * cryptographically-signed coin protocol before this endpoint is ever
 * called, verification here means confirming a genuine, matching
 * coin_ledger entry exists — not re-verifying the cryptography itself
 * (that already happened during the transfer). This is a real,
 * deliberate limit worth stating plainly: it confirms the MONEY moved
 * for certain; it does not independently confirm the member's claimed
 * PURPOSE beyond "sent to this society, recently, for at least this
 * amount." It also means each claim must consume SPECIFIC transfers exactly once (see lib/coopOfflineTransfer.js): this
 * header used to say the residual risk was only a bookkeeping misattribution, but that holds for a single claim. When one
 * real transfer could back several claims, the society recorded more collections than it received and a loan closed early
 * - a real loss, not a labelling error. Claims now bind to ledger entries, each usable once, enforced by the database.
 *
 * Auth: wallet JWT.
 * Body: { loan_id, amount_kobo }
 */
'use strict';

const crypto = require('crypto');
const { uniqueReference } = require('../../lib/coopReference');
const { logAlert } = require('../../lib/alerts');
const { findExactTransferSubset, getUnclaimedTransfers, reserveTransferClaims, releaseTransferClaims, linkTransferClaims, describeShortfall } = require('../../lib/coopOfflineTransfer');
const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { resolveMemberForZillionId } = require('../../lib/coopMemberResolve');
const { recordLoanRepaymentJournalEntry, computeLoanRepaymentSplitUnified } = require('../../lib/coopLoanAccounting');
const { settleLoanAfterRepayment } = require('../../lib/coopLoanCompletion');

const VERIFICATION_WINDOW_MINUTES = 15;

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  const zillionId = auth.payload.zillion_id;
  if (!zillionId) return err(400, 'This wallet has no linked Zillion identity yet');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const loanId       = (body.loan_id || '').trim();
  const amountKobo    = Number.isInteger(body.amount_kobo) ? body.amount_kobo : 0;
  if (!loanId)         return err(400, 'loan_id is required');
  if (amountKobo <= 0)  return err(400, 'amount_kobo must be a positive integer');

  const db = getServiceClient();

  const member = await resolveMemberForZillionId(db, zillionId, 'id, coop_id, phone_normalized, name');
  if (!member) return err(404, 'No cooperative membership found for this wallet');

  const { data: loan } = await db.from('coop_loans').select('id, coop_id, status, principal_kobo, interest_kobo, total_repayable_kobo, interest_method').eq('id', loanId).eq('member_id', member.id).maybeSingle();
  if (!loan) return err(404, 'That loan does not belong to you');
  if (!['DISBURSED', 'REPAYING'].includes(loan.status)) return err(409, `This loan is ${loan.status}, not eligible for repayment`);

  const { data: society } = await db.from('coop_societies').select('merchant_id').eq('coop_id', member.coop_id).single();
  const merchantHolderHash = `MERCHANT-${society.merchant_id}`;
  const memberHolderHash = crypto.createHash('sha256').update(member.phone_normalized).digest('hex');

  // Proof of funds: bind this claim to SPECIFIC ledger transfers, each usable once.
  const windowStart = new Date(Date.now() - VERIFICATION_WINDOW_MINUTES * 60 * 1000).toISOString();
  let found;
  try { found = await getUnclaimedTransfers(db, { memberHash: memberHolderHash, merchantHash: merchantHolderHash, windowStart }); }
  catch (e) { return err(500, 'Could not check your transfers just now. Nothing has been recorded - please try again in a moment.'); }

  const selection = findExactTransferSubset(found.unclaimed, amountKobo);
  if (!selection) {
    // A retry of a claim that already went through (a lost response, a double tap) is not an error.
    const { data: recentClaim } = await db.from('coop_loan_repayments')
      .select('id').eq('loan_id', loanId).eq('source', 'offline_zil').eq('amount_kobo', amountKobo)
      .gte('recorded_at', windowStart).limit(1).maybeSingle();
    if (recentClaim) return ok({ success: true, already_processed: true, message: 'This repayment was already recorded.' });
    return err(400, describeShortfall(found, amountKobo, VERIFICATION_WINDOW_MINUTES));
  }

  // Reserve first, then record. If anything below fails the reservation is released, so a transfer is never lost; if the
  // process dies in between, the money is merely held (a claim with no repayment), never double-credited.
  const reserved = await reserveTransferClaims(db, selection, { coopId: member.coop_id, memberId: member.id, loanId });
  if (!reserved.ok) {
    if (reserved.reason === 'already_claimed') return err(409, 'That transfer has just been applied to a repayment. If that was not you, contact your society admin.');
    return err(500, 'Could not reserve your transfer just now. Nothing has been recorded - please try again.');
  }
  const release = async (why) => {
    const r = await releaseTransferClaims(db, reserved.ids);
    if (!r.ok) await logAlert(db, { severity: 'CRITICAL', source: 'coop-repay-loan-offline',
      message: `An offline transfer was reserved for a loan repayment that then failed (${why}), and releasing the reservation ALSO failed. The transfer cannot be claimed again until its claim rows are cleared manually.`,
      context: { loan_id: loanId, member_id: member.id, claim_ids: reserved.ids } });
  };

  let principalPortionKobo, interestPortionKobo;
  try { ({ principalPortionKobo, interestPortionKobo } = await computeLoanRepaymentSplitUnified(db, loan, amountKobo)); }
  catch (e) { await release('split calculation'); return err(500, 'Could not work out the repayment split just now. Your transfer has not been used up - please try again.'); }

  const { data: repayment, error: repayErr } = await db.from('coop_loan_repayments').insert({
    loan_id: loanId,
    amount_kobo: amountKobo,
    source: 'offline_zil',
    reference: uniqueReference('Offline Zil transfer, verified via coin_ledger'),   // was one fixed sentence: only ONE offline repayment could ever be recorded platform-wide
    recorded_by: 'member:offline_zil',
    principal_portion_kobo: principalPortionKobo,
    interest_portion_kobo:  interestPortionKobo,
  }).select().single();

  if (repayErr) { await release(repayErr.message); return err(500, `Transfer verified but recording the repayment failed: ${repayErr.message}. Your transfer has not been used up - please try again.`); }
  await linkTransferClaims(db, reserved.ids, repayment.id);

  const { completed } = await settleLoanAfterRepayment(db, loan, member.coop_id);

  await recordLoanRepaymentJournalEntry(db, member.coop_id, amountKobo, 'offline_zil', 'member:offline_zil', principalPortionKobo, interestPortionKobo, { id: member.id, name: member.name });

  return ok({ success: true, repayment, message: `₦${(amountKobo/100).toLocaleString()} confirmed and applied to your loan.${completed ? ' Your loan is now fully repaid.' : ''}`, loan_completed: completed, transfers_applied: selection.length });
};
