/**
 * POST /api/v1/coins/split
 * Sprint 3: Split a large coin into smaller denominations.
 * Redeems the original coin server-side and mints new smaller coins.
 * Enables change-making and fractional payments offline.
 *
 * Auth: Device JWT
 * Body: { coin_id, amounts_kobo: number[] }
 * Example: split a ₦1000 coin into [₦500, ₦300, ₦200]
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { issueCoinBatch }   = require('../../lib/mint');
const { verifyJWT }        = require('../../lib/validators');

// Valid denominations (kobo)
const VALID_DENOMS = new Set([5000, 10000, 20000, 50000, 100000, 200000, 500000, 1000000, 2000000]);

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b    => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m)=> ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, auth.reason);

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const { coin_id, amounts_kobo } = body;
  if (!coin_id)                               return err(400, 'Missing coin_id');
  if (!Array.isArray(amounts_kobo) || amounts_kobo.length < 2)
    return err(400, 'amounts_kobo must be an array of at least 2 values');
  if (amounts_kobo.length > 20)               return err(400, 'Maximum 20 output coins per split');
  if (amounts_kobo.some(a => !VALID_DENOMS.has(a)))
    return err(400, `Invalid denomination. Valid values (kobo): ${[...VALID_DENOMS].map(d=>'₦'+(d/100)).join(', ')}`);

  const db  = getServiceClient();
  const now = new Date().toISOString();

  // Fetch and validate the source coin
  const { data: coin, error: coinErr } = await db.from('coins')
    .select('coin_id, amount, status, holder_hash, issuer_id, expires_at')
    .eq('coin_id', coin_id).single();

  if (coinErr || !coin) return err(404, `Coin not found: ${coin_id}`);
  if (coin.status !== 'HELD') return err(409, `Coin cannot be split: status is ${coin.status}`);

  // Verify the requester holds the coin
  if (coin.holder_hash !== auth.payload.sub)
    return err(403, 'You do not hold this coin');

  // Validate amounts sum equals original
  const sumOut = amounts_kobo.reduce((s, a) => s + a, 0);
  if (sumOut !== coin.amount)
    return err(400, `Output amounts sum (${sumOut} kobo) must equal original coin value (${coin.amount} kobo)`);

  // Retire the original coin
  const { error: retireErr } = await db.from('coins')
    .update({ status: 'REDEEMED', updated_at: now, holder_hash: 'SPLIT_OPERATION' })
    .eq('coin_id', coin_id).eq('status', 'HELD');
  if (retireErr) return err(500, `Failed to retire original coin: ${retireErr.message}`);

  // Mint new coins for each denomination
  const newCoins = [];
  for (const amount of amounts_kobo) {
    try {
      const batch = await issueCoinBatch({
        agentId:          coin.issuer_id || 'SPLIT',
        amountKobo:       amount,
        denominationKobo: amount,
        mintPrivateKey:   process.env.MINT_PRIVATE_KEY_HEX,
      });
      // Assign new coins directly to the requesting device
      const withHolder = batch.map(c => ({
        ...c,
        holder_hash: auth.payload.sub,
        status: 'HELD',
      }));
      newCoins.push(...withHolder);
    } catch (e) {
      // Rollback: restore original coin if any minting fails
      await db.from('coins').update({ status: 'HELD', updated_at: now, holder_hash: coin.holder_hash })
        .eq('coin_id', coin_id);
      return err(500, `Split mint failed for ₦${amount/100}: ${e.message}`);
    }
  }

  // Insert new coins
  const { error: insertErr } = await db.from('coins').insert(newCoins.map(c => ({
    coin_id:      c.coin_id,
    amount:       c.amount,
    currency:     'NGN',
    status:       'HELD',
    issuer_id:    coin.issuer_id || 'SPLIT',
    holder_hash:  auth.payload.sub,
    owner_hash:   auth.payload.sub,
    issued_at:    c.issued_at,
    expires_at:   coin.expires_at,   // inherit expiry from parent coin
    signature:    c.signature,
    payload_hash: c.payload_hash,
  })));

  if (insertErr) return err(500, `Failed to store new coins: ${insertErr.message}`);

  console.log(`[coins-split] ✅ Split ${coin_id} into ${newCoins.length} coins`);

  return ok({
    success:          true,
    original_coin_id: coin_id,
    original_amount:  coin.amount,
    new_coins:        newCoins.map(c => ({
      coin_id:     c.coin_id,
      amount_kobo: c.amount,
      amount_naira: c.amount / 100,
      expires_at:  coin.expires_at,
      signature:   c.signature,
    })),
    coin_count: newCoins.length,
    split_at:   now,
  });
};
