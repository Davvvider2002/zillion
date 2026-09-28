/**
 * zillion/backend/netlify/functions/coop-offline-repay-options.js
 *
 * GET|POST /api/v1/coop-offline-repay-options?loan_id=...
 *
 * What an offline repayment would do RIGHT NOW, so a client can show it and pre-fill instead of asking the member to type an
 * exact amount: the transfers the member has sent to their society and not yet applied, what the loan still owes, and what
 * would happen to the excess if they sent more than that. Read-only - nothing is reserved or recorded.
 *
 * Claim with the returned `claim_body` against POST /api/v1/coop-repay-loan-offline.
 * Auth: wallet JWT.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { resolveMemberForZillionId } = require('../../lib/coopMemberResolve');
const { totalRemainingForLoan } = require('../../lib/coopLoanCompletion');
const T = require('../../lib/coopOfflineTransfer');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c, m) => ({ statusCode: c, headers: hdr, body: JSON.stringify({ error: m }) });

  if (!['GET', 'POST'].includes(event.httpMethod)) return err(405, 'Method Not Allowed');
  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  const zillionId = auth.payload.zillion_id;
  if (!zillionId) return err(400, 'This wallet has no linked Zillion identity yet');

  let body = {};
  if (event.httpMethod === 'POST') { try { body = JSON.parse(event.body || '{}'); } catch { return err(400, 'Invalid JSON'); } }
  const loanId = String((event.queryStringParameters && event.queryStringParameters.loan_id) || body.loan_id || '').trim();
  if (!loanId) return err(400, 'loan_id is required');

  const db = getServiceClient();
  const member = await resolveMemberForZillionId(db, zillionId, 'id, coop_id, phone_normalized, name');
  if (!member) return err(404, 'No cooperative membership found for this wallet');

  const { data: loan } = await db.from('coop_loans').select('id, coop_id, status, principal_kobo, interest_kobo, total_repayable_kobo, interest_method').eq('id', loanId).eq('member_id', member.id).maybeSingle();
  if (!loan) return err(404, 'That loan does not belong to you');
  if (!['DISBURSED', 'REPAYING'].includes(loan.status)) return err(409, `This loan is ${loan.status}, not eligible for repayment`);

  const holders = await T.getOfflineHolders(db, member);
  if (!holders) return err(409, 'Your society is not set up to receive offline transfers yet.');

  const windowStart = new Date(Date.now() - T.OFFLINE_WINDOW_MINUTES * 60 * 1000).toISOString();
  let found, remainingKobo;
  try {
    found = await T.getUnclaimedTransfers(db, { memberHash: holders.memberHash, merchantHash: holders.merchantHash, windowStart });
    remainingKobo = await totalRemainingForLoan(db, loan, member.coop_id);
  } catch (e) { return err(500, 'Could not check your transfers just now. Please try again in a moment.'); }

  const transfers = [...found.unclaimed].sort((a, b) => Number(a.entry_id) - Number(b.entry_id));
  const out = {
    loan_id: loan.id, loan_status: loan.status, remaining_kobo: remainingKobo, window_minutes: T.OFFLINE_WINDOW_MINUTES,
    transfers: transfers.map(t => ({ entry_id: Number(t.entry_id), amount_kobo: t.amount, sent_at: t.changed_at })),
    total_kobo: transfers.reduce((s, t) => s + t.amount, 0), already_applied_count: found.claimedCount, suggested: null,
  };
  if (transfers.length && remainingKobo > 0) {
    const plan = T.planApplication(transfers, remainingKobo);
    const excessPlan = plan.excessKobo > 0 ? await T.findExcessPlan(db, member.id) : null;
    out.suggested = {
      amount_kobo: plan.totalKobo, apply_kobo: plan.applyKobo, excess_kobo: plan.excessKobo,
      excess_destination: plan.excessKobo > 0 ? (excessPlan ? 'savings' : 'held') : null,
      claim_body: { loan_id: loan.id, transfer_entry_ids: transfers.map(t => Number(t.entry_id)) },
    };
  }
  return ok(out);
};
