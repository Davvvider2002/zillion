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


    // ── DOUBLE-ENTRY: write CASH_OUT transaction record ──────────
    if (result.redeemed.length > 0) {
      try {
        const db2 = (require('../../lib/supabase')).getServiceClient();
        const txRows = result.redeemed.map(function(coinId) {
          return {
            tx_id:    'CASHOUT-' + coinId.slice(-12),
            coin_id:  coinId,
            from_hash: body.holder_hash,   // customer surrenders coin
            to_hash:   body.agent_id,      // agent receives for cash-out
            amount:    result.total_kobo ? Math.round(result.total_kobo / result.redeemed.length) : 0,
            tx_ts:     new Date().toISOString(),
            sync_ts:   new Date().toISOString(),
            env_sig:   'CASH_OUT',
            status:    'SETTLED',
            tx_type:   'CASH_OUT',
            mfb_id:    body.mfb_id || null,
            agent_id:  body.agent_id,
          };
        });
        // Set correct amounts from total
        const amtEach = Math.round(result.total_kobo / result.redeemed.length);
        txRows.forEach(function(r){ r.amount = amtEach; });
        await db2.from('transactions').insert(txRows);
      } catch(txErr) {
        console.warn('[redeem] tx record write failed (non-fatal):', txErr.message);
      }
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
