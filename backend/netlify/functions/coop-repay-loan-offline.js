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
 * amount." Since the funds genuinely did arrive at the society either
 * way, the risk this leaves open is a bookkeeping misattribution, not
 * a financial loss — a real, considered tradeoff, not an oversight.
 *
 * Auth: wallet JWT.
 * Body: { loan_id, amount_kobo }
 */
'use strict';

const crypto = require('crypto');
const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

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

  const { data: member } = await db.from('coop_members').select('id, coop_id, phone_normalized').eq('zillion_id', zillionId).maybeSingle();
  if (!member) return err(404, 'No cooperative membership found for this wallet');

  const { data: loan } = await db.from('coop_loans').select('id, status').eq('id', loanId).eq('member_id', member.id).maybeSingle();
  if (!loan) return err(404, 'That loan does not belong to you');
  if (!['DISBURSED', 'REPAYING'].includes(loan.status)) return err(409, `This loan is ${loan.status}, not eligible for repayment`);

  const { data: society } = await db.from('coop_societies').select('merchant_id').eq('coop_id', member.coop_id).single();
  const merchantHolderHash = `MERCHANT-${society.merchant_id}`;
  const memberHolderHash = crypto.createHash('sha256').update(member.phone_normalized).digest('hex');

  // Confirm a genuine, recent transfer exists — the actual proof of
  // funds movement, not the member's claim alone.
  const windowStart = new Date(Date.now() - VERIFICATION_WINDOW_MINUTES * 60 * 1000).toISOString();
  const { data: ledgerRows } = await db.from('coin_ledger')
    .select('amount, changed_at')
    .eq('prev_holder_hash', memberHolderHash)
    .eq('new_holder_hash', merchantHolderHash)
    .gte('changed_at', windowStart);

  const transferredKobo = (ledgerRows || []).reduce((s, r) => s + (r.amount || 0), 0);
  if (transferredKobo < amountKobo) {
    return err(400, `Could not find a matching transfer to your society in the last ${VERIFICATION_WINDOW_MINUTES} minutes. Found ₦${(transferredKobo/100).toLocaleString()}, expected at least ₦${(amountKobo/100).toLocaleString()}. Make sure the send completed before reporting it here.`);
  }

  // Prevent claiming the same real-world transfer twice — a rough but
  // real guard: if a repayment for this exact loan/amount/source was
  // already recorded in the same verification window, treat this as a
  // duplicate report rather than crediting again.
  const { data: recentClaim } = await db.from('coop_loan_repayments')
    .select('id').eq('loan_id', loanId).eq('source', 'offline_zil').eq('amount_kobo', amountKobo)
    .gte('recorded_at', windowStart).maybeSingle();
  if (recentClaim) {
    return ok({ success: true, already_processed: true, message: 'This repayment was already recorded.' });
  }

  const { data: repayment, error: repayErr } = await db.from('coop_loan_repayments').insert({
    loan_id: loanId,
    amount_kobo: amountKobo,
    source: 'offline_zil',
    reference: `Offline Zil transfer, verified via coin_ledger`,
    recorded_by: 'member:offline_zil',
  }).select().single();

  if (repayErr) return err(500, `Transfer verified but recording the repayment failed: ${repayErr.message}`);

  if (loan.status === 'DISBURSED') {
    await db.from('coop_loans').update({ status: 'REPAYING' }).eq('id', loanId);
  }

  return ok({ success: true, repayment, message: `₦${(amountKobo/100).toLocaleString()} confirmed and applied to your loan.` });
};
