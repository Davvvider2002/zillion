/**
 * zillion/backend/netlify/functions/coop-portal-kyc-invoice-pay-verify.js
 *
 * POST /api/v1/coop-portal-kyc-invoice-pay-verify
 *
 * Verifies a KYC-invoice payment server-side against Flutterwave (never trusts the redirect alone) and marks
 * the invoice paid — which is also what lifts the "new verifications blocked" hold for this society.
 *
 * Body: { invoice_id, transaction_id, tx_ref }
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { resolvePortalSociety } = require('../../lib/coopPortalAuth');
const { auditLog }         = require('../../lib/auditLog');
const billing = require('../../lib/coopKycBilling');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const secretKey = (process.env.FLW_V3_SECRET_KEY || '').trim();
  if (!secretKey) return err(500, 'FLW_V3_SECRET_KEY not configured');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (auth.payload?.role !== 'merchant') return err(403, 'Only the society owner can pay an invoice.');

  const db = getServiceClient();
  const resolved = await resolvePortalSociety(db, auth);
  if (!resolved.ok) return err(resolved.status, resolved.error);
  const coopId = resolved.society.coop_id;

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return err(400, 'Invalid JSON'); }
  const transactionId = body.transaction_id;
  const txRef = String(body.tx_ref || '').trim();
  if (!body.invoice_id) return err(400, 'invoice_id is required');
  if (!transactionId) return err(400, 'transaction_id is required');
  if (!txRef) return err(400, 'tx_ref is required');

  const { data: invoice } = await db.from('coop_kyc_invoices').select('*').eq('id', body.invoice_id).eq('coop_id', coopId).maybeSingle();
  if (!invoice) return err(404, 'Invoice not found');
  if (invoice.status === 'paid') return ok({ success: true, already_paid: true });
  if (invoice.tx_ref !== txRef) return err(409, 'This payment reference does not match this invoice.');

  let v;
  try {
    const res = await fetch(`https://api.flutterwave.com/v3/transactions/${transactionId}/verify`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    const verifyData = await res.json();
    v = verifyData.data;
    const verifiedOk = verifyData.status === 'success' && v?.status === 'successful' && v?.tx_ref === txRef
      && v?.currency === 'NGN' && Math.round(v?.amount) >= Math.round(invoice.total_kobo / 100);
    if (!verifiedOk) return err(402, 'Payment could not be verified as successful.');
  } catch (e) {
    console.error('[coop-portal-kyc-invoice-pay-verify]', e.message);
    return err(502, 'Could not verify payment with Flutterwave. Please try again.');
  }

  await billing.markInvoicePaid(db, invoice.id, { txRef, flwTransactionId: String(transactionId) });
  await auditLog(db, {
    action: 'COOP_KYC_INVOICE_PAID', role: 'merchant', username: resolved.society.merchant_id,
    resourceType: 'coop_kyc_invoice', resourceId: invoice.id,
    requestBody: { period_start: invoice.period_start, total_kobo: invoice.total_kobo, tx_ref: txRef },
  });

  return ok({ success: true, invoice_id: invoice.id, period_start: invoice.period_start, total_kobo: invoice.total_kobo });
};
