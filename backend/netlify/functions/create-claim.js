/**
 * POST /api/v1/create-claim
 * Agent creates a short-lived QR claim bundle.
 * Stores the full .zil bundle in Supabase with 15-min TTL.
 * Returns a claim_id used to build the QR URL.
 *
 * Body: { bundle } (full .zil bundle object)
 * Returns: { claim_id, claim_url, expires_at }
 */
'use strict';
const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode:405, body:JSON.stringify({error:'Method Not Allowed'}) };
  }
  // Auth is OPTIONAL for claim creation.
  // Customer wallets have no JWT — the coins are secured by Ed25519 mint signatures.
  // If a valid JWT is present, we use it to associate the claim with an agent.
  const auth = verifyJWT(event.headers.authorization||event.headers.Authorization||'');
  // Do NOT reject if auth is invalid — allow anonymous claim creation.

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode:400, body:JSON.stringify({error:'Invalid JSON'}) }; }

  const { bundle } = body;
  if (!bundle || !bundle.coins || !bundle.total_kobo) {
    return { statusCode:400, body:JSON.stringify({error:'bundle with coins and total_kobo required'}) };
  }

  try {
    const db = getServiceClient();

    // Clean up expired claims first
    await db.from('claim_bundles')
      .update({ status:'EXPIRED' })
      .lt('expires_at', new Date().toISOString())
      .eq('status','PENDING');

    // Insert new claim
    const { data, error } = await db
      .from('claim_bundles')
      .insert({
        bundle_data: bundle,
        // Use JWT agent_id if present; otherwise use sender_device from bundle,
        // or fall back to 'CUSTOMER' — never null (DB NOT NULL constraint).
        agent_id:    auth.valid
                       ? (auth.payload.agent_id || auth.payload.sub || 'CUSTOMER')
                       : (bundle.sender_device || 'CUSTOMER'),
        amount_kobo: bundle.total_kobo,
        coin_count:  bundle.coin_count || bundle.coins.length,
        status:      'PENDING',
      })
      .select('claim_id, expires_at')
      .single();

    if (error) throw error;

    const baseUrl   = process.env.BASE_URL || 'https://zillion-mvp.netlify.app';
    const claimUrl  = `${baseUrl}/wallet/?claim=${data.claim_id}`;

    return {
      statusCode: 200,
      headers:    {'Content-Type':'application/json'},
      body: JSON.stringify({
        success:    true,
        claim_id:   data.claim_id,
        claim_url:  claimUrl,
        expires_at: data.expires_at,
        expires_in: 900, // 15 minutes in seconds
      }),
    };
  } catch(err) {
    console.error('create-claim error:', err.message);
    return { statusCode:500, body:JSON.stringify({error:err.message}) };
  }
};
