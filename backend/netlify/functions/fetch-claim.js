/**
 * GET /api/v1/fetch-claim?claim_id=xxx
 * Customer wallet fetches the coin bundle by claim ID.
 * Marks the claim as CLAIMED after one successful fetch (one-time use).
 *
 * Returns: { bundle, agent_id, amount_kobo, coin_count }
 */
'use strict';
const { getServiceClient } = require('../../lib/supabase');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode:405, body:JSON.stringify({error:'Method Not Allowed'}) };
  }

  const claim_id = event.queryStringParameters?.claim_id;
  if (!claim_id) {
    return { statusCode:400, body:JSON.stringify({error:'claim_id required'}) };
  }

  // Basic format check
  if (!/^[a-f0-9-]{36}$/.test(claim_id)) {
    return { statusCode:400, body:JSON.stringify({error:'Invalid claim_id format'}) };
  }

  try {
    const db = getServiceClient();

    // Fetch claim
    const { data, error } = await db
      .from('claim_bundles')
      .select('*')
      .eq('claim_id', claim_id)
      .single();

    if (error || !data) {
      return {
        statusCode: 404,
        body: JSON.stringify({
          error:   'Claim not found or already used',
          detail:  'This QR code may have already been scanned or has expired',
        }),
      };
    }

    // Check status
    if (data.status === 'CLAIMED') {
      return {
        statusCode: 410,
        body: JSON.stringify({
          error:  'This QR code has already been used',
          detail: 'Each QR code can only be scanned once. Ask the agent to generate a new one.',
        }),
      };
    }

    if (data.status === 'EXPIRED' || new Date(data.expires_at) < new Date()) {
      // Mark as expired
      await db.from('claim_bundles').update({status:'EXPIRED'}).eq('claim_id',claim_id);
      return {
        statusCode: 410,
        body: JSON.stringify({
          error:  'This QR code has expired',
          detail: 'QR codes are valid for 16 hours. Ask the merchant to generate a new one.',
        }),
      };
    }

    // Mark as CLAIMED — one-time use
    await db.from('claim_bundles')
      .update({
        status:     'CLAIMED',
        claimed_at: new Date().toISOString(),
      })
      .eq('claim_id', claim_id);

    const bd = data.bundle_data || {};
    return {
      statusCode: 200,
      headers:    {'Content-Type':'application/json'},
      body: JSON.stringify({
        success:      true,
        bundle:       bd,
        type:         bd.type || 'cashin',           // cashin | cashout | payment
        agent_id:     data.agent_id,
        amount_kobo:  data.amount_kobo,
        coin_count:   data.coin_count,
        business_name:bd.business_name || null,
        merchant_id:  bd.merchant_id   || null,
        owner_phone:  bd.owner_phone   || null,
        label:        bd.label         || null,
        claimed_at:   new Date().toISOString(),
      }),
    };
  } catch(err) {
    console.error('fetch-claim error:', err.message);
    return { statusCode:500, body:JSON.stringify({error:err.message}) };
  }
};
