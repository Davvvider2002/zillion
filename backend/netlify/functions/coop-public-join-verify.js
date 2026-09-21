/**
 * zillion/backend/netlify/functions/coop-public-join-verify.js
 *
 * POST /api/v1/coop-public-join-verify
 * Body: { tx_ref, transaction_id }
 *
 * Public, unauthenticated - the second half of the paid join flow.
 * Mirrors coop-flutterwave-checkout-verify.js's proven pattern
 * exactly: re-verify server-side via Flutterwave's own v3 verify API
 * before trusting anything the redirect URL claims happened, never
 * crediting on the client's word alone.
 *
 * On confirmed payment, creates the member via the same
 * activateMember() used everywhere else membership is created
 * (backend/lib/coopActivateMember.js) - this is the ONLY point in the
 * paid-join flow where a coop_members row is actually created, so an
 * abandoned or failed payment never leaves a half-member behind.
 *
 * Idempotent by construction: if the application is already
 * COMPLETED, returns success immediately without re-processing -
 * a page reload or a duplicate client call can't create two members.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { activateMember }   = require('../../lib/coopActivateMember');
const { checkMemberCapAllows } = require('../../lib/coopMemberCap');
const { calculateFees }    = require('../../lib/coopFees');
const { logAlert }         = require('../../lib/alerts');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const secretKey = (process.env.FLW_V3_SECRET_KEY || '').trim();
  if (!secretKey) return err(500, 'FLW_V3_SECRET_KEY not configured');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const txRef = (body.tx_ref || '').trim();
  const transactionId = (body.transaction_id || '').trim();
  if (!txRef) return err(400, 'tx_ref is required');
  if (!transactionId) return err(400, 'transaction_id is required');

  const db = getServiceClient();

  const { data: application } = await db.from('coop_join_applications').select('*').eq('tx_ref', txRef).maybeSingle();
  if (!application) return err(404, 'No matching application found for this reference');

  if (application.status === 'COMPLETED') {
    return ok({ success: true, already_processed: true, message: 'This application was already confirmed and completed.' });
  }

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
  const { totalKobo } = calculateFees(application.amount_kobo);
  const verifiedOk = verifyData.status === 'success'
    && v.status === 'successful'
    && v.tx_ref === txRef
    && v.currency === 'NGN'
    && Number(v.amount) === totalKobo / 100;

  if (!verifiedOk) {
    await db.from('coop_join_applications').update({ status: 'FAILED' }).eq('id', application.id);
    return ok({ success: false, message: 'Payment could not be verified as successful.', _debug: v });
  }

  // Re-check the cap at the moment of creation, not just at init - a
  // society could have filled up in the time it took this prospect to
  // complete payment.
  const capCheck = await checkMemberCapAllows(db, application.coop_id, 1);
  if (!capCheck.ok) {
    await db.from('coop_join_applications').update({ status: 'FAILED' }).eq('id', application.id);
    return ok({ success: false, message: `Payment received, but this society has since reached its member limit. ${capCheck.error} Contact the society admin for a refund.` });
  }

  const result = await activateMember(db, {
    coopId: application.coop_id, rawPhone: application.phone, name: application.name,
    openingBalanceKobo: 0, activatedBy: 'public_join_link',
  });
  if (!result.ok) return err(500, `Payment verified but membership creation failed: ${result.error}. Contact support with reference ${txRef}.`);

  const { data: society } = await db.from('coop_societies').select('name').eq('coop_id', application.coop_id).maybeSingle();

  await db.from('coop_join_applications').update({
    status: 'COMPLETED', coop_member_id: result.member.id, completed_at: new Date().toISOString(),
  }).eq('id', application.id);

  await logAlert(db, {
    severity: 'INFO', source: 'coop-public-join-verify',
    message: `${application.name} joined ${society?.name || application.coop_id} via a paid join link (₦${(application.amount_kobo / 100).toLocaleString()})`,
    context: { coop_id: application.coop_id, member_id: result.member.id, phone: application.phone, tx_ref: txRef },
  });

  return ok({ success: true, message: `Welcome to ${society?.name || 'the society'}! Your payment was confirmed and you're now a member.` });
};
