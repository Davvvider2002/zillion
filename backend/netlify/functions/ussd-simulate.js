'use strict';
/**
 * POST /api/v1/ussd-simulate
 * DEMO/TEST ONLY — simulates what a real MFB USSD gateway would send
 * to Zillion when a customer dials *737*Zillion*AMOUNT#
 *
 * In production this endpoint is replaced by the real MFB webhook.
 * The self-load logic (coin issuance) is identical in both paths.
 *
 * Body: { phone, amount_naira, pin }
 * pin must match the SIM_PIN env var (default: "1234") for demo security
 */

const { issueCoinBatch, getAgentFloat, getDeviceByPhone } = require('../../lib/supabase');
const { applyCommission } = require('../../lib/commission');

const SIM_PIN = process.env.USSD_SIM_PIN || '1234';

// Simulated MFB account balances (demo only)
const SIM_ACCOUNTS = {
  '+2348012345678': { name: 'Kola Adekunle',    balance_naira: 50000 },
  '+2348126426726': { name: 'Demo Customer',      balance_naira: 25000 },
  '+2349012345678': { name: 'Amina Bello',        balance_naira: 15000 },
  '+2348055555555': { name: 'Test User Five',     balance_naira: 10000 },
};

exports.handler = async (event) => {
  const hdr = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: hdr, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: hdr, body: JSON.stringify({ error: 'POST only' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: hdr, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { phone, amount_naira, pin, denomination_naira } = body;

  // ── Validation ──────────────────────────────────────────────
  if (!phone || !amount_naira || !pin)
    return { statusCode: 400, headers: hdr,
      body: JSON.stringify({ error: 'phone, amount_naira and pin are required' }) };

  if (String(pin) !== String(SIM_PIN))
    return { statusCode: 401, headers: hdr,
      body: JSON.stringify({ error: 'Incorrect PIN. (SIM demo PIN: 1234)' }) };

  const amountNaira = parseInt(amount_naira, 10);
  if (isNaN(amountNaira) || amountNaira < 100 || amountNaira > 50000)
    return { statusCode: 400, headers: hdr,
      body: JSON.stringify({ error: 'Amount must be between ₦100 and ₦50,000' }) };

  // ── Simulate MFB account check ───────────────────────────────
  const account = SIM_ACCOUNTS[phone];
  if (!account)
    return { statusCode: 404, headers: hdr,
      body: JSON.stringify({ error: `No simulated MFB account for ${phone}. Use +2348012345678 or +2348126426726.` }) };

  if (account.balance_naira < amountNaira)
    return { statusCode: 422, headers: hdr,
      body: JSON.stringify({
        error: `Insufficient MFB balance. Available: ₦${account.balance_naira.toLocaleString()}`,
        sim_balance: account.balance_naira,
      }) };

  // ── Deduct from simulated balance ────────────────────────────
  account.balance_naira -= amountNaira;

  // ── Work out coin denomination ───────────────────────────────
  const denomNaira = parseInt(denomination_naira, 10) || 1000;
  const denomKobo  = denomNaira * 100;
  const totalKobo  = amountNaira * 100;

  if (totalKobo % denomKobo !== 0)
    return { statusCode: 400, headers: hdr,
      body: JSON.stringify({
        error: `Amount (₦${amountNaira}) must be a multiple of the denomination (₦${denomNaira})`,
      }) };

  const coinCount = totalKobo / denomKobo;

  // ── Issue coins via existing Zillion engine ──────────────────
  let coins;
  try {
    coins = await issueCoinBatch({
      agent_id:    'USSD-SELF-LOAD',
      phone:        phone,
      amount:       totalKobo,
      denomination: denomKobo,
      coin_count:   coinCount,
      source:       'ussd_self_load',
      mfb_ref:      'SIM-' + Date.now(),
    });
  } catch (issueErr) {
    // Re-credit simulated balance on failure
    account.balance_naira += amountNaira;
    return { statusCode: 500, headers: hdr,
      body: JSON.stringify({ error: 'Coin issuance failed: ' + issueErr.message }) };
  }

  // ── Record commission (USSD self-load, no agent) ─────────────
  try {
    await applyCommission({
      txnType:    'cash_in',
      amountKobo: totalKobo,
      agentId:    null,
      mfbId:      'SIM_MFB',
      coinId:     coins[0]?.coin_id || null,
    });
  } catch(ce) {
    console.warn('[commission] ussd self-load (non-fatal):', ce.message);
  }

  // ── Build SMS-style USSD confirmation (what the real gateway sends) ──
  const ref = 'ZIL' + Date.now().toString(36).toUpperCase();
  const confirmMsg = [
    'Zillion Load Successful',
    `Amount: N${amountNaira.toLocaleString()}`,
    `Coins: ${coinCount} x N${denomNaira.toLocaleString()}`,
    `Ref: ${ref}`,
    `MFB balance: N${account.balance_naira.toLocaleString()}`,
    'Open Zillion Wallet to use offline.',
  ].join('\n');

  return {
    statusCode: 200,
    headers: hdr,
    body: JSON.stringify({
      success:         true,
      sim_mode:        true,
      phone,
      amount_naira:    amountNaira,
      coin_count:      coinCount,
      denomination:    denomNaira,
      coins_issued:    coins.length,
      ref,
      ussd_response:   confirmMsg,
      sim_mfb_balance: account.balance_naira,
      message:         `${coinCount} Zillion coin(s) of ₦${denomNaira.toLocaleString()} issued to ${phone}. Sync wallet to load coins.`,
    }),
  };
};
