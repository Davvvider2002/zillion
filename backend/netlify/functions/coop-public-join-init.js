/**
 * zillion/backend/netlify/functions/coop-public-join-init.js
 *
 * POST /api/v1/coop-public-join-init
 * Body: { coop_id, name, phone, email? }
 *
 * Public, unauthenticated - the first step of a prospect joining a
 * society via a shared link or QR code. Two paths:
 *
 * - joining_fee_kobo === 0: enrols immediately via the same
 *   activateMember() used by single activation and bulk import
 *   (backend/lib/coopActivateMember.js) - no separate "free join"
 *   code path to drift out of sync with how membership is created
 *   everywhere else.
 * - joining_fee_kobo > 0: creates a coop_join_applications row and
 *   opens a Flutterwave v3 hosted checkout session, reusing the exact
 *   fee calculation (backend/lib/coopFees.js) and multi-tenant
 *   subaccount split already proven in coop-flutterwave-checkout-init.js
 *   for dues and savings - a prospect pays base + Flutterwave's real
 *   fee + Zillion's matching fee, same as every other Coop payment.
 *   The member row itself is only created on confirmed payment
 *   (coop-public-join-verify.js), not here - so a payment that's
 *   abandoned or fails never leaves a half-created member behind.
 *
 * The member cap is checked BEFORE accepting any payment - a society
 * already at its plan's limit should never collect a joining fee for
 * a membership it can't actually grant.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { activateMember, normalisePhone } = require('../../lib/coopActivateMember');
const { checkMemberCapAllows } = require('../../lib/coopMemberCap');
const { calculateFees }    = require('../../lib/coopFees');
const { logAlert }         = require('../../lib/alerts');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const coopId = (body.coop_id || '').trim();
  const name   = (body.name || '').trim();
  const phone  = (body.phone || '').trim();
  const email  = (body.email || '').trim() || null;
  const returnUrl = (body.return_url || '').trim();

  if (!coopId) return err(400, 'coop_id is required');
  if (!name)   return err(400, 'name is required');
  if (!phone)  return err(400, 'phone is required');

  const db = getServiceClient();

  const { data: society } = await db.from('coop_societies').select('coop_id, name, joining_fee_kobo, flutterwave_subaccount_id').eq('coop_id', coopId).maybeSingle();
  if (!society) return err(404, 'Society not found');

  const capCheck = await checkMemberCapAllows(db, coopId, 1);
  if (!capCheck.ok) return err(409, capCheck.error);

  const joiningFeeKobo = society.joining_fee_kobo || 0;

  if (joiningFeeKobo === 0) {
    const result = await activateMember(db, { coopId, rawPhone: phone, name, openingBalanceKobo: 0, activatedBy: 'public_join_link' });
    if (!result.ok) return err(400, result.error);
    if (result.status === 'already_existed') return err(409, 'This phone number is already a member of this society');

    await logAlert(db, {
      severity: 'INFO', source: 'coop-public-join-init',
      message: `${name} joined ${society.name} via a free join link`,
      context: { coop_id: coopId, member_id: result.member.id, phone },
    });

    return ok({ success: true, requires_payment: false, message: `Welcome to ${society.name}! You're now a member.` });
  }

  // Paid joining fee - don't create the member yet, just the application.
  const { data: existingMember } = await db.from('coop_members').select('id').eq('coop_id', coopId).eq('phone_normalized', normalisePhone(phone)).maybeSingle();
  if (existingMember) return err(409, 'This phone number is already a member of this society');

  const secretKey = (process.env.FLW_V3_SECRET_KEY || '').trim();
  if (!secretKey) return err(500, 'Payments are not yet configured for this society - contact the society admin');
  if (!returnUrl) return err(400, 'return_url is required');

  const { baseKobo, flutterwaveFeeKobo, zillionFeeKobo, stampDutyKobo, totalKobo } = calculateFees(joiningFeeKobo);

  const { data: application, error: appErr } = await db.from('coop_join_applications').insert({
    coop_id: coopId, name, phone, email, amount_kobo: baseKobo, status: 'PENDING_PAYMENT',
  }).select().single();
  if (appErr) return err(500, `Failed to start application: ${appErr.message}`);

  const txRef = `ZILJOIN-${application.id.slice(0, 8)}-${Date.now()}`;
  const separator = returnUrl.includes('?') ? '&' : '?';
  const redirectUrl = `${returnUrl}${separator}checkout_return=1&tx_ref=${txRef}`;

  const paymentPayload = {
    tx_ref: txRef,
    amount: String(totalKobo / 100),
    currency: 'NGN',
    redirect_url: redirectUrl,
    customer: {
      email: email || `join.${phone.replace(/\D/g, '')}@savings.zillion.ng`,
      name,
      phonenumber: phone,
    },
    customizations: { title: `Join ${society.name}` },
  };

  // transaction_charge_type must be 'flat_subaccount', not 'flat' -
  // see the detailed fix note in coop-flutterwave-checkout-init.js,
  // where this exact bug was found via a real transaction receipt
  // showing settlement going to the wrong account. Fixed here too,
  // since this code was copied from that same pattern.
  if (society.flutterwave_subaccount_id) {
    paymentPayload.subaccounts = [{ id: society.flutterwave_subaccount_id, transaction_charge_type: 'flat_subaccount', transaction_charge: baseKobo / 100 }];
  }

  let flwResponse;
  try {
    const res = await fetch('https://api.flutterwave.com/v3/payments', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(paymentPayload),
    });
    flwResponse = await res.json();
    if (flwResponse.status !== 'success' || !flwResponse.data?.link) {
      return err(502, `Flutterwave rejected the checkout request: ${flwResponse.message || 'unknown error'}`);
    }
  } catch (e) {
    return err(502, `Failed to reach Flutterwave: ${e.message}`);
  }

  await db.from('coop_join_applications').update({ tx_ref: txRef }).eq('id', application.id);

  return ok({
    success: true, requires_payment: true, checkout_url: flwResponse.data.link, tx_ref: txRef,
    fee_breakdown: { base_kobo: baseKobo, flutterwave_fee_kobo: flutterwaveFeeKobo, zillion_fee_kobo: zillionFeeKobo, stamp_duty_kobo: stampDutyKobo, total_kobo: totalKobo },
  });
};
