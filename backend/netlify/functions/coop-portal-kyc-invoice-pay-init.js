/**
 * zillion/backend/netlify/functions/coop-portal-kyc-invoice-pay-init.js
 *
 * POST /api/v1/coop-portal-kyc-invoice-pay-init
 *
 * Starts a one-off Flutterwave checkout for a specific unpaid KYC usage invoice (not a recurring plan — the
 * amount is different every month). Owner-only. Returns a Flutterwave checkout link; coop-portal-kyc-invoice-
 * pay-verify.js confirms the payment server-side afterwards.
 *
 * Body: { invoice_id, return_url }
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { resolvePortalSociety } = require('../../lib/coopPortalAuth');

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
  if (!body.invoice_id) return err(400, 'invoice_id is required');
  if (!body.return_url) return err(400, 'return_url is required');

  const { data: invoice } = await db.from('coop_kyc_invoices').select('*').eq('id', body.invoice_id).eq('coop_id', coopId).maybeSingle();
  if (!invoice) return err(404, 'Invoice not found');
  if (invoice.status === 'paid') return err(409, 'This invoice is already paid.');
  if (invoice.status !== 'pending_payment') return err(409, `This invoice is still ${invoice.status === 'accruing' ? 'accruing for the current month' : invoice.status} and is not yet payable.`);
  if (invoice.total_kobo <= 0) return err(409, 'This invoice has no amount owing.');

  const txRef = invoice.tx_ref || `KYC-${coopId}-${invoice.period_start}-${Date.now()}`;

  let initData;
  try {
    const res = await fetch('https://api.flutterwave.com/v3/payments', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tx_ref: txRef,
        amount: invoice.total_kobo / 100,
        currency: 'NGN',
        redirect_url: body.return_url,
        customer: { email: resolved.society.subscription_email || `${coopId}@zillion.ng`, name: resolved.society.name },
        customizations: { title: 'Zillion Coop — NIN Verification Usage', description: `${invoice.period_start.slice(0, 7)} — ${invoice.verification_count} verification(s)` },
      }),
    });
    initData = await res.json();
    if (!res.ok || initData.status !== 'success') throw new Error(initData.message || 'Flutterwave init failed');
  } catch (e) {
    console.error('[coop-portal-kyc-invoice-pay-init]', e.message);
    return err(502, 'Could not start payment. Please try again.');
  }

  await db.from('coop_kyc_invoices').update({ tx_ref: txRef }).eq('id', invoice.id);

  return ok({ success: true, authorization_url: initData.data.link, tx_ref: txRef });
};
