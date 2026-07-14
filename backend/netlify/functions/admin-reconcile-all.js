'use strict';
/**
 * POST /api/v1/admin-reconcile-all
 * Full balance and holder_hash reconciliation.
 * Admin JWT required.
 */
const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const crypto               = require('crypto');

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b    => ({ statusCode:200, headers:hdr, body:JSON.stringify(b) });
  const err = (c,m)=> ({ statusCode:c,   headers:hdr, body:JSON.stringify({error:m}) });

  if (event.httpMethod !== 'POST') return err(405,'Method Not Allowed');
  const auth = verifyJWT(event.headers.authorization||event.headers.Authorization||'');
  if (!auth.valid || auth.payload.role !== 'admin') return err(401,'Admin required');

  const db  = getServiceClient();
  const now = new Date().toISOString();
  const report = { timestamp: now, fixes: [], warnings: [], summary: {} };

  try {
    // ── 1. Get ALL agents and verify float balance ──────────────────────
    const { data: agents } = await db.from('agents').select('*');
    report.summary.agents_checked = (agents||[]).length;
    let agent_discrepancies = 0;

    for (const agent of (agents||[])) {
      // Compute actual balance from coins table
      const { data: agentCoins } = await db.from('coins')
        .select('amount, status')
        .eq('holder_hash', agent.agent_id)
        .eq('status', 'ISSUED');

      const computedFloat = (agentCoins||[]).reduce((s,c) => s+(c.amount||0), 0);
      const dbFloat       = agent.float_balance_kobo || 0;

      if (Math.abs(computedFloat - dbFloat) > 100) {
        report.warnings.push({
          type: 'AGENT_FLOAT_MISMATCH',
          agent_id: agent.agent_id,
          db_float: dbFloat,
          computed_float: computedFloat,
          difference: dbFloat - computedFloat,
        });
        agent_discrepancies++;
      }
    }
    report.summary.agent_float_discrepancies = agent_discrepancies;

    // ── 2. Get ALL coins where holder_hash looks like an HMAC (64 hex chars)
    //    but is NOT a SHA256(phone) format (phones start with + )
    //    Find these by checking if a device record links them to a phone ──
    const { data: heldCoins } = await db.from('coins')
      .select('coin_id, amount, holder_hash, issuer_id, status, issued_at')
      .eq('status', 'HELD')
      .limit(500);

    let reassigned = 0;
    const phoneHashCache = {};

    for (const coin of (heldCoins||[])) {
      const h = coin.holder_hash || '';
      // Skip if holder_hash is an agent ID or looks like a device ID
      if (h.startsWith('AGENT-') || h.startsWith('DEVICE-') || h.startsWith('MDEV-')) continue;
      // Skip if already correct (we can't easily verify without phone lookup)

      // Try to find device record with this holder_hash
      if (!phoneHashCache[h]) {
        const { data: dev } = await db.from('devices')
          .select('phone_number, phone_hash, device_hash')
          .eq('holder_hash', h).maybeSingle();

        if (dev?.phone_number) {
          let phone = dev.phone_number.replace(/\s/g,'');
          if (phone.startsWith('0') && phone.length===11) phone='+234'+phone.slice(1);
          if (!phone.startsWith('+')) phone='+'+phone;
          const correctHash = sha256(phone);
          phoneHashCache[h] = { phone, correctHash };
        }
      }

      const mapping = phoneHashCache[h];
      if (mapping && mapping.correctHash !== h) {
        // Update coin to use SHA256(phone) as holder_hash
        await db.from('coins').update({
          holder_hash: mapping.correctHash,
          updated_at:  now,
        }).eq('coin_id', coin.coin_id);

        // Update device record too
        await db.from('devices').update({
          holder_hash: mapping.correctHash,
        }).eq('holder_hash', h);

        report.fixes.push({
          type:      'HOLDER_HASH_CORRECTED',
          coin_id:   coin.coin_id,
          amount:    coin.amount,
          phone:     mapping.phone,
          old_hash:  h.slice(0,16)+'...',
          new_hash:  mapping.correctHash.slice(0,16)+'...',
        });
        reassigned++;
      }
    }
    report.summary.coins_reassigned = reassigned;

    // ── 3. Get all coins summary ──────────────────────────────────────────
    const { count: totalCoins } = await db.from('coins')
      .select('*', { count:'exact', head:true });
    const { count: heldCount } = await db.from('coins')
      .select('*', { count:'exact', head:true }).eq('status','HELD');
    const { count: issuedCount } = await db.from('coins')
      .select('*', { count:'exact', head:true }).eq('status','ISSUED');
    const { count: spentCount } = await db.from('coins')
      .select('*', { count:'exact', head:true }).eq('status','SPENT');

    report.summary.coins = {
      total: totalCoins, held: heldCount,
      issued: issuedCount, spent: spentCount,
    };

    // ── 4. Get total value in circulation ─────────────────────────────────
    const { data: circulatingCoins } = await db.from('coins')
      .select('amount').eq('status','HELD');
    const circulating = (circulatingCoins||[]).reduce((s,c)=>s+(c.amount||0),0);
    report.summary.total_in_circulation_kobo = circulating;
    report.summary.total_in_circulation_naira = circulating / 100;

    // ── 5. Transaction count ─────────────────────────────────────────────
    const { count: txCount } = await db.from('transactions')
      .select('*', { count:'exact', head:true });
    report.summary.transactions = txCount;

    report.status = 'COMPLETE';
    report.message = reassigned > 0
      ? reassigned + ' coins re-assigned to correct SHA256(phone) holder_hash'
      : 'No hash corrections needed — all coins already under correct holder_hash';

    return ok(report);
  } catch(e) {
    return err(500, e.message);
  }
};
