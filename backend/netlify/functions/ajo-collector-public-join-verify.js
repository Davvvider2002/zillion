/**
 * zillion/backend/netlify/functions/ajo-collector-public-join-verify.js
 *
 * POST /api/v1/ajo-collector-public-join-verify
 * Body: { tx_ref, transaction_id }
 *
 * Public, unauthenticated - mirrors coop-public-join-verify.js's
 * proven pattern exactly: re-verify server-side via Flutterwave's own
 * v3 verify API before trusting anything the redirect URL claims
 * happened.
 *
 * On confirmed payment: resolves or creates this person's Zillion
 * wallet identity (a brand-new phone number is fully supported, same
 * as Coop's own paid join), then gets-or-creates their
 * ajo_collector_profiles row. Deliberately leaves escrow_status
 * exactly as NOT_STARTED (its own table default) - paying the joining
 * fee is a separate, additional gate, confirmed directly, not a
 * substitute for escrow verification. Getting from here to an active,
 * collecting collector still requires the full, unchanged KYC +
 * admin-approval flow (ajo-collector-provision-escrow.js /
 * ajo-admin-verify-collector-escrow.js).
 *
 * Idempotent by construction: an already-COMPLETED application
 * returns success immediately without re-processing.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { resolveOrCreateZillionId } = require('../../lib/zillionId');
const { calculateFees } = require('../../lib/coopFees');
const { logAlert } = require('../../lib/alerts');

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

  const { data: application } = await db.from('ajo_collector_join_applications').select('*').eq('tx_ref', txRef).maybeSingle();
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
    await db.from('ajo_collector_join_applications').update({ status: 'FAILED' }).eq('id', application.id);
    return ok({ success: false, message: 'Payment could not be verified as successful.', _debug: v });
  }

  const zillionId = await resolveOrCreateZillionId(db, application.phone, 'ajo_collector');

  let { data: profile } = await db.from('ajo_collector_profiles').select('*').eq('zillion_id', zillionId).maybeSingle();
  if (!profile) {
    const { data: created, error: profileErr } = await db.from('ajo_collector_profiles').insert({ zillion_id: zillionId }).select().single();
    if (profileErr) return err(500, `Payment verified but your collector profile could not be created: ${profileErr.message}. Contact support with reference ${txRef}.`);
    profile = created;
  }

  await db.from('ajo_collector_join_applications').update({
    status: 'COMPLETED', collector_profile_id: profile.id, completed_at: new Date().toISOString(),
  }).eq('id', application.id);

  await logAlert(db, {
    severity: 'INFO', source: 'ajo-collector-public-join-verify',
    message: `${application.name} paid the joining fee to become an Ajo collector (₦${(application.amount_kobo / 100).toLocaleString()}) - escrow setup still required before activation`,
    context: { collector_profile_id: profile.id, phone: application.phone, tx_ref: txRef, recruiting_admin_zillion_id: application.recruiting_admin_zillion_id },
  });

  return ok({
    success: true,
    escrow_status: profile.escrow_status,
    message: 'Payment confirmed! One more step: complete your escrow verification in the wallet before you can start collecting.',
  });
};
