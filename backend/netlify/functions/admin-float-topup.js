/**
 * POST /api/v1/admin-float-topup
 *
 * Admin mints coins equal to cash deposited by agent.
 * This is the SINGLE entry point for value creation in Zillion.
 * No float top-up = no coins = no value in circulation.
 *
 * Auth: Admin JWT
 * Body: { agent_id, amount_kobo, denomination_kobo, deposit_ref }
 *
 * Flow:
 *   1. Admin verifies physical cash received from agent
 *   2. Admin calls this endpoint
 *   3. Mint creates Ed25519-signed coins = exact cash value
 *   4. Coins stored in DB (status=ISSUED, issuer=ZILLION-MINT-01)
 *   5. Agent float_balance_kobo increased by amount
 *   6. Audit trail written to float_topups table
 */
'use strict';

const { issueCoinBatch }    = require('../../lib/mint');
const { getServiceClient }  = require('../../lib/supabase');
const { verifyJWT }         = require('../../lib/validators');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST')
    return { statusCode:405, body:JSON.stringify({error:'Method Not Allowed'}) };

  // Admin-only
  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid || auth.payload.role !== 'admin')
    return { statusCode:401, body:JSON.stringify({error:'Admin access required'}) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode:400, body:JSON.stringify({error:'Invalid JSON'}) }; }

  const { agent_id, amount_kobo, denomination_kobo = 50000, deposit_ref = '' } = body;

  if (!agent_id)                             return { statusCode:400, body:JSON.stringify({error:'Missing agent_id'}) };
  if (!amount_kobo || amount_kobo <= 0)      return { statusCode:400, body:JSON.stringify({error:'Invalid amount_kobo'}) };
  if (amount_kobo > 100_000_000)             return { statusCode:400, body:JSON.stringify({error:'Amount exceeds single top-up limit'}) };
  if (amount_kobo % denomination_kobo !== 0) return { statusCode:400, body:JSON.stringify({error:'amount_kobo must be divisible by denomination_kobo'}) };

  const db = getServiceClient();

  // 1. Verify agent exists
  const { data:agent, error:agentErr } = await db.from('agents').select('*').eq('agent_id', agent_id).single();
  if (agentErr || !agent) return { statusCode:404, body:JSON.stringify({error:'Agent not found'}) };

  // 2. Get current coin sequence for this agent to avoid ID collisions
  const { count:existingCoins } = await db.from('coins')
    .select('*',{count:'exact',head:true}).eq('issuer_id', agent_id);
  const sequenceStart = (existingCoins || 0) + 1;

  // 3. Mint coins — these are cryptographically tied to ZILLION-MINT-01
  let coins;
  try {
    coins = issueCoinBatch({
      totalAmountKobo: amount_kobo,
      coinValueKobo:   denomination_kobo,
      recipientPhone:  agent.phone,
      recipientDevice: agent_id,       // agent_id as device for float coins
      agentId:         agent_id,
      mintPrivateKey:  process.env.MINT_PRIVATE_KEY_HEX,
      mintId:          process.env.MINT_ID || 'ZILLION-MINT-01',
      ownerSalt:       process.env.SUPABASE_SERVICE_KEY,
      sequenceStart,
      expiryDays:      parseInt(process.env.COIN_EXPIRY_DAYS || '90'),
    });
  } catch(err) {
    return { statusCode:500, body:JSON.stringify({error:`Mint failed: ${err.message}`}) };
  }

  // 4. Insert coins into registry (status=ISSUED, holder=agent)
  const coinRows = coins.map(c => ({
    coin_id:     c.coin_id,
    amount:      c.amount,
    currency:    c.currency || 'NGN',
    issued_at:   c.issued_at,
    expires_at:  c.expires_at,
    issuer_id:   agent_id,
    status:      'ISSUED',          // moves to HELD when agent issues to customer
    holder_hash: agent_id,          // agent holds them in float
    mint_sig:    c.signature,
  }));

  const { error:insertErr } = await db.from('coins').insert(coinRows);
  if (insertErr) return { statusCode:500, body:JSON.stringify({error:`DB insert failed: ${insertErr.message}`}) };

  // 5. Update agent float
  const { error:floatErr } = await db.from('agents')
    .update({ float_balance_kobo: agent.float_balance_kobo + amount_kobo, last_activity: new Date().toISOString() })
    .eq('agent_id', agent_id);
  if (floatErr) return { statusCode:500, body:JSON.stringify({error:`Float update failed: ${floatErr.message}`}) };

  // 6. Write immutable audit trail
  await db.from('float_topups').insert({
    agent_id,
    amount_kobo,
    denomination_kobo,
    coin_count:    coins.length,
    first_coin_id: coins[0].coin_id,
    last_coin_id:  coins[coins.length-1].coin_id,
    deposit_ref,
    approved_by:   auth.payload.sub || 'admin',
    created_at:    new Date().toISOString(),
  }).catch(()=>{}); // non-fatal if table doesn't exist yet

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      success:        true,
      agent_id,
      amount_kobo,
      coin_count:     coins.length,
      denomination:   denomination_kobo,
      new_float_kobo: agent.float_balance_kobo + amount_kobo,
      first_coin_id:  coins[0].coin_id,
      last_coin_id:   coins[coins.length-1].coin_id,
      minted_at:      new Date().toISOString(),
    }),
  };
};
