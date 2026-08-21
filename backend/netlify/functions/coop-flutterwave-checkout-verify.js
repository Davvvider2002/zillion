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
const { calculateFees }    = require('../../lib/coopFees');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  const zillionId = auth.payload.zillion_id;
  if (!zillionId) return err(400, 'This wallet has no linked Zillion identity yet');

  const secretKey = process.env.FLW_V3_SECRET_KEY;
  if (!secretKey) return err(500, 'FLW_V3_SECRET_KEY not configured');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const txRef         = (body.tx_ref || '').trim();
  const transactionId  = (body.transaction_id || '').trim();
  if (!txRef)          return err(400, 'tx_ref is required');
  if (!transactionId)   return err(400, 'transaction_id is required');

  const db = getServiceClient();

  const { data: member } = await db.from('coop_members').select('id').eq('zillion_id', zillionId).maybeSingle();
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

  // Credit the correct ledger — session.type/amount/member_id/coop_id
  // came from OUR OWN record of what this tx_ref was created for, never
  // from anything the client just sent.
  const LEDGER_TABLES = { savings: 'coop_savings_transactions', dues: 'coop_dues_transactions', loan_repayment: 'coop_loan_repayments' };
  const ledgerTable = LEDGER_TABLES[session.type];
  const insertRow = session.type === 'loan_repayment'
    ? { loan_id: session.loan_id, amount_kobo: session.amount_kobo, source: 'flutterwave_checkout', reference: txRef, recorded_by: 'checkout:flutterwave_v3' }
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

  return ok({
    success: true,
    type: session.type,
    amount_kobo: session.amount_kobo,
    message: `Payment confirmed — ₦${(session.amount_kobo / 100).toLocaleString()} credited to your ${{ savings: 'savings', dues: 'dues', loan_repayment: 'loan repayment' }[session.type]}.`,
  });
};
