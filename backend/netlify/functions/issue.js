/**
 * zillion/backend/netlify/functions/issue.js
 *
 * POST /api/v1/issue
 * Agent requests new .zil coins for a customer cash-in.
 *
 * Auth: Agent JWT (Bearer token)
 * Body: { amount: number, recipient_hash: string, agent_id: string,
 *         coin_denomination?: number, recipient_phone?: string, recipient_device?: string }
 */

'use strict';

const { issueCoinBatch }     = require('../../lib/mint');
const { insertCoins, markCoinsHeld, getAgentFloat, updateAgentFloat } = require('../../lib/supabase');
const { validateIssueRequest, verifyJWT } = require('../../lib/validators');

exports.handler = async (event) => {
  // Only accept POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  // Auth check
  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) {
    return { statusCode: 401, body: JSON.stringify({ error: auth.reason }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  // Validate request
  const { valid, errors } = validateIssueRequest(body);
  if (!valid) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Validation failed', errors }) };
  }

  // ── Rate limit: max 10 issue calls per agent per minute (G14) ──
  try {
    const { createClient } = require('@supabase/supabase-js');
    const rdb = createClient(
      process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY,
      { auth: { persistSession: false } }
    );
    const oneMinAgo = new Date(Date.now() - 60000).toISOString();
    const { count: recentIssues } = await rdb
      .from('transactions')
      .select('*', { count: 'exact', head: true })
      .eq('from_hash', body.agent_id)
      .gte('sync_ts', oneMinAgo);
    if ((recentIssues || 0) >= 10) {
      return { statusCode: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
        body: JSON.stringify({ error: 'Rate limit: max 10 coin issuances per minute per agent',
          retry_after: 60 }) };
    }
  } catch (rateErr) {
    console.warn('[issue] Rate limit check failed (non-fatal):', rateErr.message);
    // Non-fatal — proceed if rate limit check itself fails
  }

  // Check agent float — agent must have sufficient balance
  try {
    const agent = await getAgentFloat(body.agent_id);
    if (!agent) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Agent not found' }) };
    }
    if (agent.float_balance_kobo < body.amount) {
      return {
        statusCode: 402,
        body: JSON.stringify({
          error:   'Insufficient agent float',
          required: body.amount,
          available: agent.float_balance_kobo,
        }),
      };
    }
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: `Float check failed: ${err.message}` }) };
  }

  // Issue coins from Mint
  const denomination = body.coin_denomination ||
    parseInt(process.env.MAX_COIN_VALUE_KOBO || '100000');

  let coins;
  try {
    coins = await issueCoinBatch({
      totalAmountKobo:  body.amount,
      coinValueKobo:    denomination,
      recipientPhone:   body.recipient_phone   || 'UNKNOWN',
      recipientDevice:  body.recipient_device  || 'UNKNOWN',
      agentId:          body.agent_id,
      mintPrivateKey:   process.env.MINT_PRIVATE_KEY_HEX,
      mintId:           process.env.MINT_ID || 'ZILLION-MINT-01',
      ownerSalt:        process.env.SUPABASE_SERVICE_KEY, // reuse a long secret as salt
      sequenceStart:    Date.now(),                       // use timestamp as sequence in POC
      expiryDays:       parseInt(process.env.COIN_EXPIRY_DAYS || '90'),
    });
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: `Mint failed: ${err.message}` }) };
  }

  // Persist to registry
  try {
    await insertCoins(coins, body.agent_id);
    await markCoinsHeld(coins.map(c => c.coin_id), body.recipient_hash);
    await updateAgentFloat(body.agent_id, -body.amount); // deduct from agent float
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: `Registry error: ${err.message}` }) };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      success:    true,
      coin_count: coins.length,
      total_kobo: body.amount,
      coins,                    // returned to agent app for delivery to customer
    }),
  };
};
