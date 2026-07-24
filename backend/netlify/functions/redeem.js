/**
 * zillion/backend/netlify/functions/redeem.js
 *
 * POST /api/v1/redeem
 * Agent submits coins for customer cash-out.
 * Requires online connection — registry check is mandatory.
 *
 * Auth: Agent JWT
 * Body: { agent_id: string, holder_hash: string, coin_ids: string[] }
 */

'use strict';

const { redeemCoins, updateAgentFloat } = require('../../lib/supabase');
const { applyCommission } = require('../../lib/commission');
const { verifyJWT }                     = require('../../lib/validators');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

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

  if (!body.agent_id || !body.holder_hash || !Array.isArray(body.coin_ids)) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Required: agent_id, holder_hash, coin_ids[]' }),
    };
  }

  if (body.coin_ids.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'coin_ids cannot be empty' }) };
  }

  if (body.coin_ids.length > 50) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Max 50 coins per redemption' }) };
  }

  try {
    const result = await redeemCoins(body.coin_ids, body.holder_hash, body.agent_id);

    // Credit agent float for successfully redeemed coins
    if (result.total_kobo > 0) {
      await updateAgentFloat(body.agent_id, result.total_kobo);
    }

    if(result.total_kobo>0){try{await applyCommission({txnType:'cash_out',amountKobo:result.total_kobo,agentId:body.agent_id,mfbId:body.mfb_id||null,coinId:body.coin_ids[0]||null});}catch(ce){console.warn('[commission]',ce.message);}}
    const totalNaira = result.total_kobo / 100;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success:       true,
        redeemed:      result.redeemed,
        rejected:      result.rejected,
        total_kobo:    result.total_kobo,
        total_naira:   totalNaira,
        redeemed_count: result.redeemed.length,
        rejected_count: result.rejected.length,
        message:       `Pay customer ₦${totalNaira.toLocaleString()}`,
        redeemed_at:   new Date().toISOString(),
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: `Redemption failed: ${err.message}` }) };
  }
};
