/**
 * zillion/backend/netlify/functions/ajo-collector-public-join-init.js
 *
 * POST /api/v1/ajo-collector-public-join-init
 * Body: { admin_zillion_id, name, phone, email?, return_url }
 *
 * Public, unauthenticated - mirrors coop-public-join-init.js exactly,
 * but there is no free path here: the joining fee is compulsory, per
 * how this was specified, not optional the way a society's own
 * joining fee can be zero. Every submission creates an
 * ajo_collector_join_applications row and opens a real Flutterwave
 * v3 checkout - the same fee calculation and payment mechanics
 * already proven for dues/savings/shares, reused rather than
 * reinvented.
 *
 * Paying the fee does NOT activate the collector - escrow
 * verification remains the sole activation trigger, exactly as
 * clarified directly. This endpoint and its verify counterpart only
 * ever create or confirm the ajo_collector_profiles row at
 * NOT_STARTED; getting from there to ACTIVE still requires the full,
 * separate KYC + admin-approval flow (ajo-collector-provision-escrow.js
 * / ajo-admin-verify-collector-escrow.js) exactly as it already works
 * for every other collector.
 *
 * A brand-new phone number is fully supported here, same as Coop's
 * own public join - resolveOrCreateZillionId creates the wallet
 * identity itself if this person has never touched Zillion before,
 * rather than requiring them to sign up separately first.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { calculateFees } = require('../../lib/coopFees');

function normalisePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('234')) return '+' + digits;
  if (digits.startsWith('0'))   return '+234' + digits.slice(1);
  return '+234' + digits;
}

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const adminZillionId = (body.admin_zillion_id || '').trim();
  const name  = (body.name || '').trim();
  const rawPhone = (body.phone || '').trim();
  const email = (body.email || '').trim() || null;
  const returnUrl = (body.return_url || '').trim();

  if (!adminZillionId) return err(400, 'admin_zillion_id is required — use the link or QR code exactly as given');
  if (!name)  return err(400, 'name is required');
  if (!rawPhone) return err(400, 'phone is required');
  if (!returnUrl) return err(400, 'return_url is required');

  const phone = normalisePhone(rawPhone);
  const db = getServiceClient();

  const { data: settings } = await db.from('ajo_collector_recruitment_settings')
    .select('joining_fee_kobo').eq('admin_zillion_id', adminZillionId).maybeSingle();
  if (!settings) return err(404, 'This join link is no longer active — the admin has not set a joining fee');

  const secretKey = (process.env.FLW_V3_SECRET_KEY || '').trim();
  if (!secretKey) return err(500, 'Payments are not yet configured — contact support');

  const { baseKobo, flutterwaveFeeKobo, zillionFeeKobo, stampDutyKobo, totalKobo } = calculateFees(settings.joining_fee_kobo);

  const { data: application, error: appErr } = await db.from('ajo_collector_join_applications').insert({
    recruiting_admin_zillion_id: adminZillionId, name, phone, email, amount_kobo: baseKobo, status: 'PENDING_PAYMENT',
  }).select().single();
  if (appErr) return err(500, `Failed to start application: ${appErr.message}`);

  const txRef = `ZILAJOCOLLJOIN-${application.id.slice(0, 8)}-${Date.now()}`;
  const separator = returnUrl.includes('?') ? '&' : '?';
  const redirectUrl = `${returnUrl}${separator}checkout_return=1&tx_ref=${txRef}`;

  const paymentPayload = {
    tx_ref: txRef,
    amount: String(totalKobo / 100),
    currency: 'NGN',
    redirect_url: redirectUrl,
    customer: {
      email: email || `collector-join.${phone.replace(/\D/g, '')}@savings.zillion.ng`,
      name,
      phonenumber: phone,
    },
    customizations: { title: 'Zillion Ajo — Become a Collector' },
  };

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

  await db.from('ajo_collector_join_applications').update({ tx_ref: txRef }).eq('id', application.id);

  return ok({
    success: true, checkout_url: flwResponse.data.link, tx_ref: txRef,
    fee_breakdown: { base_kobo: baseKobo, flutterwave_fee_kobo: flutterwaveFeeKobo, zillion_fee_kobo: zillionFeeKobo, stamp_duty_kobo: stampDutyKobo, total_kobo: totalKobo },
  });
};
