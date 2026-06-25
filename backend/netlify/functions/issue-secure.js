/**
 * zillion/backend/netlify/functions/issue.js
 *
 * POST /api/v1/issue
 * Agent requests new .zil coins for a customer cash-in.
 *
 * Priority 3 additions:
 *   - Hourly velocity cap per agent (default ₦50,000/hour)
 *   - Self-issuance detection and fraud flagging
 *   - Input length caps against enumeration
 *   - Denomination whitelist
 *
 * Auth: Agent JWT (Bearer token)
 * Body: { amount, recipient_hash, agent_id, coin_denomination?,
 *         recipient_phone?, recipient_device?, agent_device_id? }
 */

'use strict';

const { issueCoinBatch }     = require('../../lib/mint');
const {
  insertCoins, markCoinsHeld,
  getAgentFloat, updateAgentFloat,
  logFraudEvent,
}                            = require('../../lib/supabase');
const { validateIssueRequest, verifyJWT } = require('../../lib/validators');

// ── Config ────────────────────────────────────────────────────────────────────
const AGENT_HOURLY_LIMIT_KOBO = parseInt(process.env.AGENT_HOURLY_LIMIT_KOBO || '5000000'); // ₦50,000
const AGENT_DAILY_LIMIT_KOBO  = parseInt(process.env.AGENT_DAILY_LIMIT_KOBO  || '50000000'); // ₦500,000
const ALLOWED_DENOMS          = [50000, 100000, 200000, 500000]; // ₦500, ₦1k, ₦2k, ₦5k
const MAX_SINGLE_ISSUE_KOBO   = parseInt(process.env.MAX_SINGLE_ISSUE_KOBO   || '200000');  // ₦2,000

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  // ── Auth ──────────────────────────────────────────────────────────────────
  const auth = verifyJWT(
    event.headers.authorization || event.headers.Authorization || ''
  );
  if (!auth.valid) return err(401, auth.reason);

  // ── Parse body ────────────────────────────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON body'); }

  // ── Input length caps (prevent enumeration / oversized payloads) ──────────
  if (typeof body.recipient_hash   === 'string' && body.recipient_hash.length   > 128) return err(400, 'recipient_hash too long');
  if (typeof body.agent_id         === 'string' && body.agent_id.length         > 32)  return err(400, 'agent_id too long');
  if (typeof body.recipient_phone  === 'string' && body.recipient_phone.length  > 20)  return err(400, 'recipient_phone too long');
  if (typeof body.recipient_device === 'string' && body.recipient_device.length > 64)  return err(400, 'recipient_device too long');
  if (typeof body.agent_device_id  === 'string' && body.agent_device_id.length  > 64)  return err(400, 'agent_device_id too long');

  // ── Validate request structure ────────────────────────────────────────────
  const { valid, errors } = validateIssueRequest(body);
  if (!valid) return err(400, `Validation failed: ${errors?.join(', ')}`);

  // ── Denomination whitelist ────────────────────────────────────────────────
  const denomination = body.coin_denomination
    || parseInt(process.env.MAX_COIN_VALUE_KOBO || '100000');

  if (!ALLOWED_DENOMS.includes(denomination)) {
    return err(400,
      `Invalid denomination ${denomination}. ` +
      `Allowed: ${ALLOWED_DENOMS.map(d => '₦' + d/100).join(', ')}`
    );
  }

  // ── Single-issue cap ──────────────────────────────────────────────────────
  if (body.amount > MAX_SINGLE_ISSUE_KOBO) {
    return err(400,
      `Single issue limit is ₦${MAX_SINGLE_ISSUE_KOBO/100}. ` +
      `Requested ₦${body.amount/100}. Issue multiple smaller amounts.`
    );
  }

  // ── Amount must divide evenly into denomination ───────────────────────────
  if (body.amount % denomination !== 0) {
    return err(400,
      `Amount ₦${body.amount/100} is not divisible by ` +
      `denomination ₦${denomination/100}.`
    );
  }

  // ── Supabase setup ────────────────────────────────────────────────────────
  const { getServiceClient } = require('../../lib/supabase');
  const db = getServiceClient();

  // ── Agent float check ─────────────────────────────────────────────────────
  let agent;
  try {
    agent = await getAgentFloat(body.agent_id);
    if (!agent) return err(403, 'Agent not found or not authorised');
    if (agent.float_balance_kobo < body.amount) {
      return err(402, JSON.stringify({
        error:     'Insufficient agent float',
        required:  body.amount,
        available: agent.float_balance_kobo,
        tip:       'Contact admin to top up float',
      }));
    }
  } catch (e) {
    return err(500, `Float check failed: ${e.message}`);
  }

  // ── VELOCITY CHECK: Hourly cap ────────────────────────────────────────────
  // Prevents a rogue agent from draining their entire float in minutes
  try {
    const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const { data: hourlyCoins, error: hErr } = await db
      .from('coins')
      .select('amount')
      .eq('issuer_id', body.agent_id)
      .gte('issued_at', oneHourAgo);

    if (!hErr && hourlyCoins) {
      const hourlyTotal = hourlyCoins.reduce((s, c) => s + (c.amount || 0), 0);
      if (hourlyTotal + body.amount > AGENT_HOURLY_LIMIT_KOBO) {
        // Log this as a potential fraud event for admin review
        await logFraudEvent(
          body.agent_id, 'VELOCITY_HOURLY_EXCEEDED',
          `Attempted ₦${(hourlyTotal + body.amount)/100} in last hour (limit ₦${AGENT_HOURLY_LIMIT_KOBO/100})`
        ).catch(() => {});
        return err(429,
          `Hourly issuance limit reached. ` +
          `Issued ₦${hourlyTotal/100} this hour. ` +
          `Limit is ₦${AGENT_HOURLY_LIMIT_KOBO/100}. ` +
          `Wait or contact admin to increase limit.`
        );
      }
    }
  } catch (e) {
    // Velocity check failure is non-fatal — log and continue
    console.error('[issue] velocity check error:', e.message);
  }

  // ── VELOCITY CHECK: Daily cap ─────────────────────────────────────────────
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const { data: dailyCoins, error: dErr } = await db
      .from('coins')
      .select('amount')
      .eq('issuer_id', body.agent_id)
      .gte('issued_at', today.toISOString());

    if (!dErr && dailyCoins) {
      const dailyTotal = dailyCoins.reduce((s, c) => s + (c.amount || 0), 0);
      if (dailyTotal + body.amount > AGENT_DAILY_LIMIT_KOBO) {
        await logFraudEvent(
          body.agent_id, 'VELOCITY_DAILY_EXCEEDED',
          `Attempted ₦${(dailyTotal + body.amount)/100} today (limit ₦${AGENT_DAILY_LIMIT_KOBO/100})`
        ).catch(() => {});
        return err(429,
          `Daily issuance limit reached. ` +
          `Issued ₦${dailyTotal/100} today. ` +
          `Limit is ₦${AGENT_DAILY_LIMIT_KOBO/100}. ` +
          `Resets at midnight.`
        );
      }
    }
  } catch (e) {
    console.error('[issue] daily velocity check error:', e.message);
  }

  // ── SELF-ISSUANCE DETECTION ───────────────────────────────────────────────
  // Flag when agent issues to their own device (common in early fraud attempts)
  // We do NOT block — a legitimate agent may test with their own phone.
  // But we log it for admin review.
  const agentDevice     = (body.agent_device_id  || '').trim();
  const recipientDevice = (body.recipient_device || '').trim();

  if (agentDevice && recipientDevice && agentDevice === recipientDevice) {
    console.warn(`[issue] ⚠️  SELF-ISSUANCE: agent=${body.agent_id} device=${agentDevice} amount=₦${body.amount/100}`);
    await logFraudEvent(
      body.agent_id, 'AGENT_SELF_ISSUANCE',
      `Agent issued ₦${body.amount/100} to own device ${agentDevice}`
    ).catch(() => {});
    // Do NOT return error — let it proceed but it's flagged in admin Fraud tab
  }

  // ── Mint coins ────────────────────────────────────────────────────────────
  let coins;
  try {
    coins = issueCoinBatch({
      totalAmountKobo:  body.amount,
      coinValueKobo:    denomination,
      recipientPhone:   body.recipient_phone  || 'UNKNOWN',
      recipientDevice:  body.recipient_device || 'UNKNOWN',
      agentId:          body.agent_id,
      mintPrivateKey:   process.env.MINT_PRIVATE_KEY_HEX,
      mintId:           process.env.MINT_ID || 'ZILLION-MINT-01',
      ownerSalt:        process.env.SUPABASE_SERVICE_KEY,
      sequenceStart:    Date.now(),
      expiryDays:       parseInt(process.env.COIN_EXPIRY_DAYS || '90'),
    });
  } catch (e) {
    return err(500, `Mint failed: ${e.message}`);
  }

  // ── Persist to registry ───────────────────────────────────────────────────
  try {
    await insertCoins(coins, body.agent_id);
    await markCoinsHeld(coins.map(c => c.coin_id), body.recipient_hash);
    await updateAgentFloat(body.agent_id, -body.amount);
  } catch (e) {
    return err(500, `Registry error: ${e.message}`);
  }

  console.log(`[issue] ✅ agent=${body.agent_id} amount=₦${body.amount/100} coins=${coins.length}`);

  return ok({
    success:    true,
    coin_count: coins.length,
    total_kobo: body.amount,
    coins,
  });
};
