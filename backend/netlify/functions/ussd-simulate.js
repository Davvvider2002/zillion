'use strict';
/**
 * POST /api/v1/ussd-simulate
 * DEMO/TEST ONLY — simulates the MFB USSD gateway webhook.
 * Uses the exact same coin issuance path as issue.js.
 *
 * Body: { phone, amount_naira, denomination_naira, pin }
 * PIN must match USSD_SIM_PIN env var (default: "1234")
 */

const { issueCoinBatch }   = require('../../lib/mint');
const { insertCoins, markCoinsHeld } = require('../../lib/supabase');
const { applyCommission }  = require('../../lib/commission');

const SIM_PIN = process.env.USSD_SIM_PIN || '1234';

const SIM_ACCOUNTS = {
  '+27621685478':   { name: 'David (SA Demo)',    balance_naira: 100000 },
  '+2348012345678': { name: 'Kola Adekunle',      balance_naira: 50000  },
  '+2348126426726': { name: 'Demo Customer',       balance_naira: 25000  },
  '+2349012345678': { name: 'Amina Bello',         balance_naira: 15000  },
  '+2348055555555': { name: 'Test User Five',      balance_naira: 10000  },
};

exports.handler = async (event) => {
  const hdr = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: hdr, body: '' };
  if (event.httpMethod !== 'POST') return err(405, 'POST only');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const { phone, amount_naira, pin, denomination_naira } = body;

  // ── Validation ────────────────────────────────────────────────
  if (!phone || !amount_naira || !pin)
    return err(400, 'phone, amount_naira and pin are required');

  if (String(pin) !== String(SIM_PIN))
    return err(401, 'Incorrect PIN (demo PIN is 1234)');

  const amountNaira = parseInt(amount_naira, 10);
  if (isNaN(amountNaira) || amountNaira < 100 || amountNaira > 50000)
    return err(400, 'Amount must be between N100 and N50,000');

  // ── Simulated MFB account ─────────────────────────────────────
  const account = SIM_ACCOUNTS[phone];
  if (!account)
    return err(404, 'No simulated account for ' + phone + '. Use +27621685478 or +2348012345678.');

  if (account.balance_naira < amountNaira)
    return err(422, 'Insufficient MFB balance. Available: N' + account.balance_naira.toLocaleString());

  account.balance_naira -= amountNaira;

  // ── Coin parameters ───────────────────────────────────────────
  const denomNaira  = parseInt(denomination_naira, 10) || 1000;
  const denomKobo   = denomNaira  * 100;
  const totalKobo   = amountNaira * 100;

  if (totalKobo % denomKobo !== 0) {
    account.balance_naira += amountNaira; // refund sim balance
    return err(400, 'Amount (N' + amountNaira + ') must be a multiple of denomination (N' + denomNaira + ')');
  }

  const coinCount = totalKobo / denomKobo;

  // ── Issue coins — identical to issue.js ───────────────────────
  let coins;
  try {
    coins = await issueCoinBatch({
      totalAmountKobo:  totalKobo,
      coinValueKobo:    denomKobo,
      recipientPhone:   phone,
      recipientDevice:  'USSD-SELF-LOAD',
      agentId:          'USSD-SELF-LOAD',
      mintPrivateKey:   process.env.MINT_PRIVATE_KEY_HEX,
      mintId:           process.env.MINT_ID || 'ZILLION-MINT-01',
      ownerSalt:        process.env.SUPABASE_SERVICE_KEY,
      sequenceStart:    Date.now(),
      expiryDays:       parseInt(process.env.COIN_EXPIRY_DAYS || '90'),
    });
  } catch (issueErr) {
    account.balance_naira += amountNaira; // refund sim balance on failure
    return err(500, 'Coin issuance failed: ' + issueErr.message);
  }

  // ── Persist coins to Supabase ─────────────────────────────────
  try {
    await insertCoins(coins, 'USSD-SELF-LOAD');
    // Derive holder hash from phone (same as wallet registration)
    const crypto    = require('crypto');
    const salt      = process.env.SUPABASE_SERVICE_KEY || 'zillion-salt';
    const holderHash = crypto.createHmac('sha256', salt).update(phone).digest('hex');
    await markCoinsHeld(coins.map(c => c.coin_id), holderHash);
  } catch (dbErr) {
    console.error('[ussd-sim] DB persist failed:', dbErr.message);
    // coins were minted but not saved — non-fatal for demo, log for production
  }


  // ── DOUBLE-ENTRY: write SELF_LOAD transaction record ──────────
  try {
    const db2 = require('../../lib/supabase').getServiceClient();
    const txRows2 = coins.map(function(c) {
      return {
        tx_id:    'SELFLOAD-' + c.coin_id.slice(-12),
        coin_id:  c.coin_id,
        from_hash: 'MFB-FLOAT',          // MFB float is debited
        to_hash:   phone,                 // customer wallet credited
        amount:    c.amount,
        tx_ts:     new Date().toISOString(),
        sync_ts:   new Date().toISOString(),
        env_sig:   'USSD_SELF_LOAD',
        status:    'SETTLED',
        tx_type:   'USSD_SELF_LOAD',
        mfb_id:    body.mfb_id || 'SIM_MFB',
        agent_id:  null,
      };
    });
    await db2.from('transactions').insert(txRows2);
  } catch(txErr2) {
    console.warn('[ussd-sim] tx record write failed (non-fatal):', txErr2.message);
  }

  // ── Commission ────────────────────────────────────────────────
  try {
    await applyCommission({
      txnType:    'ussd_self_load',
      mfbId:      body.mfb_id || 'SIM_MFB',
      amountKobo: totalKobo,
      agentId:    null,
      mfbId:      'SIM_MFB',
      coinId:     coins[0] && coins[0].coin_id,
    });
  } catch (ce) {
    console.warn('[commission] ussd self-load non-fatal:', ce.message);
  }

  // ── SMS confirmation text ─────────────────────────────────────
  const ref = 'ZIL' + Date.now().toString(36).toUpperCase();
  const smsLines = [
    'Zillion Load Successful',
    'Amount:  N' + amountNaira.toLocaleString(),
    'Coins:   ' + coinCount + ' x N' + denomNaira.toLocaleString(),
    'Ref:     ' + ref,
    'MFB bal: N' + account.balance_naira.toLocaleString(),
    'Open Zillion Wallet to spend offline.',
  ];

  return ok({
    success:          true,
    sim_mode:         true,
    phone,
    amount_naira:     amountNaira,
    coin_count:       coinCount,
    denomination:     denomNaira,
    coins_issued:     coins.length,
    ref,
    ussd_response:    smsLines.join('\n'),
    sim_mfb_balance:  account.balance_naira,
    message:          coinCount + ' Zillion coin(s) of N' + denomNaira.toLocaleString() + ' issued to ' + phone,
  });
};
