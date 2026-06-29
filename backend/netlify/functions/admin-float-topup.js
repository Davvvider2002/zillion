/**
 * POST /api/v1/admin-float-topup
 *
 * Admin mints coins equal to cash deposited by agent.
 * This is the SINGLE entry point for value creation in Zillion.
 *
 * Auth: Admin JWT
 * Body: { agent_id, amount_kobo, denomination_kobo, deposit_ref }
 */
'use strict';

const { issueCoinBatch }   = require('../../lib/mint');
const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

const ok  = (body) => ({ statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const err = (code, msg) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false, error: msg }) });

exports.handler = async (event) => {
  // Always return JSON — even on unexpected crash
  try {
    if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

    // ── Auth ──────────────────────────────────────────────────
    const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
    if (!auth.valid)                        return err(401, 'Invalid or missing token: ' + auth.reason);
    if (auth.payload.role !== 'admin')      return err(401, 'Admin access required');

    // ── Parse body ────────────────────────────────────────────
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch(e) { return err(400, 'Invalid JSON body'); }

    const {
      agent_id,
      amount_kobo,
      denomination_kobo = 100000,
      deposit_ref = '',
    } = body;

    // ── Validate inputs ───────────────────────────────────────
    if (!agent_id)                               return err(400, 'Missing agent_id');
    if (!amount_kobo || amount_kobo <= 0)        return err(400, 'amount_kobo must be a positive number');
    if (!Number.isInteger(amount_kobo))          return err(400, 'amount_kobo must be an integer (kobo)');
    if (amount_kobo > 100_000_000)               return err(400, 'Exceeds single top-up limit of ₦1,000,000');
    if (!Number.isInteger(denomination_kobo))    return err(400, 'denomination_kobo must be an integer');
    if (amount_kobo % denomination_kobo !== 0)   return err(400, `amount_kobo (${amount_kobo}) must be divisible by denomination_kobo (${denomination_kobo})`);

    // ── Check env vars before attempting mint ─────────────────
    // Signing: KMS (ZILLION_KMS_KEY_ARN) takes priority over local key (MINT_PRIVATE_KEY_HEX)
    if (!process.env.ZILLION_KMS_KEY_ARN && !process.env.MINT_PRIVATE_KEY_HEX)
      return err(500, 'No signing method configured: set ZILLION_KMS_KEY_ARN (production) or MINT_PRIVATE_KEY_HEX (dev)');
    if (!process.env.SUPABASE_URL)         return err(500, 'SUPABASE_URL not configured');
    if (!process.env.SUPABASE_SERVICE_KEY) return err(500, 'SUPABASE_SERVICE_KEY not configured');

    const db = getServiceClient();

    // ── 1. Verify agent exists ────────────────────────────────
    const agentResult = await db.from('agents').select('*').eq('agent_id', agent_id).single();
    if (agentResult.error) return err(404, 'Agent not found: ' + agentResult.error.message);
    const agent = agentResult.data;
    if (!agent) return err(404, 'Agent not found: ' + agent_id);

    // ── 2. Get sequence start (avoid coin_id collisions) ──────
    const countResult = await db.from('coins')
      .select('*', { count: 'exact', head: true })
      .eq('issuer_id', agent_id);
    const sequenceStart = ((countResult.count) || 0) + 1;

    // ── 3. Mint coins ─────────────────────────────────────────
    let coins;
    try {
      coins = await issueCoinBatch({
        totalAmountKobo:  amount_kobo,
        coinValueKobo:    denomination_kobo,
        recipientPhone:   agent.phone || agent_id,
        recipientDevice:  agent_id,
        agentId:          agent_id,
        mintPrivateKey:   process.env.MINT_PRIVATE_KEY_HEX, // undefined in prod — KMS used instead
        mintId:           process.env.MINT_ID || 'ZILLION-MINT-01',
        ownerSalt:        process.env.SUPABASE_SERVICE_KEY,
        sequenceStart,
        expiryDays:       parseInt(process.env.COIN_EXPIRY_DAYS || '90'),
      });
    } catch(mintErr) {
      return err(500, 'Mint failed: ' + mintErr.message);
    }

    if (!coins || !coins.length) return err(500, 'Mint produced no coins');

    // ── 4. Insert coins into registry ─────────────────────────
    const coinRows = coins.map(c => ({
      coin_id:     c.coin_id,
      amount:      c.amount,
      currency:    c.currency || 'NGN',
      issued_at:   c.issued_at,
      expires_at:  c.expires_at,
      issuer_id:   agent_id,
      status:      'ISSUED',
      holder_hash: agent_id,
      mint_sig:    c.signature,
    }));

    const insertResult = await db.from('coins').insert(coinRows);
    if (insertResult.error) {
      return err(500, 'DB insert failed: ' + insertResult.error.message);
    }

    // ── 5. Update agent float ─────────────────────────────────
    const newFloat = agent.float_balance_kobo + amount_kobo;
    const updateResult = await db.from('agents')
      .update({ float_balance_kobo: newFloat, last_activity: new Date().toISOString() })
      .eq('agent_id', agent_id);
    if (updateResult.error) {
      return err(500, 'Float update failed: ' + updateResult.error.message);
    }

    // ── 6. Audit trail (non-fatal — float_topups table may not exist yet) ──
    try {
      await db.from('float_topups').insert({
        agent_id,
        amount_kobo,
        denomination_kobo,
        coin_count:    coins.length,
        first_coin_id: coins[0].coin_id,
        last_coin_id:  coins[coins.length - 1].coin_id,
        deposit_ref:   deposit_ref || '',
        approved_by:   auth.payload.sub || 'admin',
        created_at:    new Date().toISOString(),
      });
    } catch(auditErr) {
      // Non-fatal — log but don't fail the whole request
      console.warn('Audit trail write failed (non-fatal):', auditErr.message);
    }

    // ── 7. Create claim bundle so admin can show a QR for agent ─
    // Agent scans QR → wallet opens → agent confirms receipt of float
    let claim_id  = null;
    let claim_url = null;
    try {
      const claimRecord = {
        bundle_data: {
          type:          'float_topup',
          agent_id,
          amount_kobo,
          coin_count:    coins.length,
          denomination_kobo,
          coin_ids:      coins.map(c => c.coin_id),
          deposit_ref:   deposit_ref || '',
          minted_at:     new Date().toISOString(),
        },
        agent_id,
        amount_kobo,
        coin_count:  coins.length,
        status:      'PENDING',
        expires_at:  new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 hours
      };
      const { data: claimData, error: claimErr } = await db
        .from('claim_bundles')
        .insert(claimRecord)
        .select('claim_id')
        .single();
      if (!claimErr && claimData) {
        claim_id  = claimData.claim_id;
        const base = process.env.BASE_URL || 'https://zillion-mvp.netlify.app';
        claim_url = `${base}/agent/?claim=${claim_id}&type=float_topup`;
      }
    } catch(claimErr) {
      // Non-fatal — float was credited, just no QR
      console.warn('Claim bundle creation failed (non-fatal):', claimErr.message);
    }

    // ── 8. Return success ─────────────────────────────────────
    return ok({
      success:        true,
      agent_id,
      agent_name:     agent.name,
      amount_kobo,
      coin_count:     coins.length,
      denomination_kobo,
      new_float_kobo: newFloat,
      first_coin_id:  coins[0].coin_id,
      last_coin_id:   coins[coins.length - 1].coin_id,
      minted_at:      new Date().toISOString(),
      // QR data — admin uses this to show a scannable QR to the agent
      claim_id,
      claim_url,
    });

  } catch(unexpectedErr) {
    // Catch-all — guarantees a JSON response even on unhandled errors
    console.error('admin-float-topup unexpected error:', unexpectedErr);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: 'Internal error: ' + unexpectedErr.message }),
    };
  }
};
