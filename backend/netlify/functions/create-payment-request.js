/**
 * POST /api/v1/create-payment-request
 * Customer OR merchant creates a payment QR.
 * Two use cases:
 *   1. Customer wants cash from agent: type=cashout, includes their coin bundle
 *   2. Merchant displays static QR for customers to pay them
 *
 * Body: { type, bundle?, amount_kobo, owner_phone, label? }
 * Returns: { claim_id, claim_url, expires_at }
 */
'use strict';
const { getServiceClient } = require('../../lib/supabase');
const { limitByIp, tooManyRequests } = require('../../lib/publicRateLimit');
const { cleanText } = require('../../lib/cleanText');

const MAX_BODY_BYTES = 200 * 1024;      // a real coin bundle is a few KB
const MAX_AMOUNT_KOBO = 5_000_000_00;   // ₦5,000,000 ceiling on a single request

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST')
    return { statusCode:405, body:JSON.stringify({error:'Method Not Allowed'}) };

  // Anyone can call this, so cap the size and the rate, and validate everything it stores.
  if ((event.body || '').length > MAX_BODY_BYTES)
    return { statusCode:413, body:JSON.stringify({error:'Request too large'}) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode:400, body:JSON.stringify({error:'Invalid JSON'}) }; }

  const type = body.type;
  if (type !== 'cashout' && type !== 'payment')
    return { statusCode:400, body:JSON.stringify({error:'type required: cashout | payment'}) };

  const bundle = (body.bundle && typeof body.bundle === 'object') ? body.bundle : null;
  const amountRaw = Number(body.amount_kobo);
  if (body.amount_kobo != null && (!Number.isInteger(amountRaw) || amountRaw < 0 || amountRaw > MAX_AMOUNT_KOBO))
    return { statusCode:400, body:JSON.stringify({error:'amount_kobo must be a whole number of kobo within limits'}) };
  const amount_kobo   = body.amount_kobo != null ? amountRaw : null;
  const owner_phone   = cleanText(body.owner_phone, 20);
  const business_name = cleanText(body.business_name, 120);
  const label         = cleanText(body.label, 120);
  const merchant_id   = cleanText(body.merchant_id, 60);

  try {
    const db = getServiceClient();

    const rl = await limitByIp(db, event, 'create-payment-request', { windowMinutes: 60, maxAttempts: 60, lockoutMinutes: 60 });
    if (!rl.allowed) return tooManyRequests(rl.retryAfterSeconds, 'payment requests');

    // (An update that expired every old claim ran here on every call. Removed: fetch-claim already checks the expiry
    // time itself, so it only gave a flood of requests a free table-wide write to hammer.)

    const record = {
      bundle_data:  bundle || { type, amount_kobo, owner_phone, business_name, merchant_id, label },
      agent_id:     owner_phone || merchant_id || 'CUSTOMER',
      amount_kobo:  amount_kobo || (bundle?.total_kobo) || 0,
      coin_count:   bundle?.coins?.length || 0,
      status:       'PENDING',
      // Payment requests can have longer expiry (merchant static QR = 24h)
      expires_at:   new Date(Date.now() + (type==='payment' ? 86400000 : 57600000)).toISOString(), // cashout = 16 hours
    };

    const { data, error } = await db
      .from('claim_bundles')
      .insert(record)
      .select('claim_id, expires_at')
      .single();

    if (error) throw error;

    const baseUrl  = process.env.BASE_URL || 'https://zillion.ng';
    // Route claim URL to correct app based on who needs to scan it:
    // cashout = agent scans (merchant wants cash) → /agent/
    // payment = customer wallet scans → /wallet/
    const claimPath = (type === 'cashout') ? '/agent/' : '/wallet/';
    const claimUrl  = `${baseUrl}${claimPath}?claim=${data.claim_id}&type=${type}`;

    return {
      statusCode: 200,
      headers:    {'Content-Type':'application/json'},
      body: JSON.stringify({
        success:    true,
        claim_id:   data.claim_id,
        claim_url:  claimUrl,
        type,
        expires_at: data.expires_at,
        expires_in: type==='payment' ? 86400 : 57600,
      }),
    };
  } catch(err) {
    console.error('create-payment-request:', err.message);
    return { statusCode:500, body:JSON.stringify({error:'Could not create the request. Please try again.'}) };
  }
};
