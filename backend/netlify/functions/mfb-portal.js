'use strict';

const { corsOrigin } = require('../../lib/cors');
/**
 * MFB Portal API — all data endpoints for the MFB dashboard
 *
 * Requires JWT with role='mfb' and mfb_id claim.
 * Each MFB can ONLY see their own data — enforced server-side.
 *
 * GET  /api/v1/mfb-portal            — full dashboard data
 * POST /api/v1/mfb-portal            — actions (change_password, export_request)
 * GET  /api/v1/mfb-portal?section=agents         — agent list
 * GET  /api/v1/mfb-portal?section=coins          — coin ledger
 * GET  /api/v1/mfb-portal?section=transactions   — transaction history
 * GET  /api/v1/mfb-portal?section=commission     — commission breakdown
 * GET  /api/v1/mfb-portal?section=alerts         — compliance alerts
 */

const crypto           = require('crypto');
const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }    = require('../../lib/validators');

// FIX: previously fell back to a hardcoded, guessable secret when the
// real env var was unset — a full auth-bypass / privacy risk. Now fails
// loudly instead of silently using a weak, predictable key.
function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error('Server misconfigured: ' + name + ' is not set');
  return v;
}


// Resolved lazily inside handlers, not at module load — throwing here
// would fail the whole function's initialization (every invocation 502s
// with no catchable error).
function getJwtSecret() { return mustEnv('JWT_SECRET'); }

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function signJWT(payload) {
  const h = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
  const b = Buffer.from(JSON.stringify({...payload,
    iat: Math.floor(Date.now()/1000),
    exp: Math.floor(Date.now()/1000)+86400*7,
  })).toString('base64url');
  const s = crypto.createHmac('sha256',getJwtSecret()).update(h+'.'+b).digest('base64url');
  return h+'.'+b+'.'+s;
}

exports.handler = async (event) => {
  const hdr = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': corsOrigin(event),
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: hdr, body: '' };

  // Auth — must have valid MFB token
  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (auth.payload.role !== 'mfb' && auth.payload.role !== 'mfb_session') return err(403, 'MFB access only');

  const mfbId = auth.payload.mfb_id;
  if (!mfbId) return err(401, 'Invalid token — missing mfb_id');

  const db      = getServiceClient();
  const p       = event.queryStringParameters || {};
  const section = p.section || 'dashboard';

  // ── POST actions ─────────────────────────────────────────────
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body||'{}'); } catch { return err(400,'Invalid JSON'); }
    const action = body.action || p.action;

    try {
    if (action === 'change_password') {
      const { new_password } = body;
      if (!new_password || new_password.length < 8)
        return err(400, 'Password must be at least 8 characters');
      const hash = sha256(new_password);
      await db.from('mfb_partners').update({
        portal_password_hash: hash,
        portal_first_login:   false,
        updated_at:           new Date().toISOString(),
      }).eq('mfb_id', mfbId);
      const newToken = signJWT({ role:'mfb', mfb_id: mfbId, sub: mfbId });
      return ok({ success: true, token: newToken });
    }
    return err(400, 'Unknown action');
    } catch (e) {
      console.error('[mfb-portal] POST unhandled error:', e.message);
      return err(500, 'Server error: ' + e.message);
    }
  }

  if (event.httpMethod !== 'GET') return err(405, 'GET or POST only');

  try {
    // ── MFB partner details ───────────────────────────────────
    const { data: partner } = await db.from('mfb_partners').select('*').eq('mfb_id', mfbId).maybeSingle();
    if (!partner) return err(404, 'MFB partner not found');

    // ── Agents for this MFB ───────────────────────────────────
    const { data: agents } = await db.from('agents').select('*').eq('mfb_id', mfbId);
    const agentIds = new Set((agents||[]).map(a => a.agent_id));

    if (section === 'agents') {
      return ok({ agents: agents||[], agent_count: (agents||[]).length });
    }

    // ── Coins ─────────────────────────────────────────────────
    const { data: allCoins } = await db.from('coins')
      .select('coin_id,amount,status,issuer_id,issued_at,holder_hash')
      .in('issuer_id', [...agentIds, 'USSD-SELF-LOAD']);

    // filter self-load coins to this MFB via commission_events
    const { data: commEvents } = await db.from('commission_events')
      .select('coin_id,mfb_id,fee_kobo,mfb_kobo,zillion_kobo,agent_kobo,txn_type,agent_id,created_at')
      .eq('mfb_id', mfbId)
      .order('created_at', { ascending: false });

    const selfLoadCoinIds = new Set(
      (commEvents||[]).filter(e => !e.agent_id).map(e => e.coin_id).filter(Boolean)
    );

    const coins = (allCoins||[]).filter(c =>
      agentIds.has(c.issuer_id) || selfLoadCoinIds.has(c.coin_id)
    );

    if (section === 'coins') {
      const page = parseInt(p.page||'1');
      const limit = 100;
      const paginated = coins.slice((page-1)*limit, page*limit);
      return ok({ coins: paginated, total: coins.length, page });
    }

    // ── Coin aggregates ───────────────────────────────────────
    let minted=0, held=0, issued=0, redeemed=0, vMinted=0, vHeld=0, vIssued=0, vRedeemed=0;
    coins.forEach(c => {
      if (c.status==='FROZEN') return;
      minted++; vMinted += c.amount;
      if (c.status==='HELD')                        { held++;     vHeld     += c.amount; }
      if (c.status==='ISSUED')                      { issued++;   vIssued   += c.amount; }
      if (c.status==='REDEEMED'||c.status==='SPENT') { redeemed++; vRedeemed += c.amount; }
    });

    // ── Transactions ──────────────────────────────────────────
    const { data: txns } = await db.from('transactions')
      .select('tx_id,coin_id,amount,tx_type,status,from_hash,to_hash,agent_id,tx_ts')
      .eq('mfb_id', mfbId)
      .order('tx_ts', { ascending: false })
      .limit(section==='transactions' ? 500 : 100);

    if (section === 'transactions') {
      return ok({ transactions: txns||[], total: (txns||[]).length });
    }

    // Tx breakdown
    let cashin=0, cashout=0, selfload=0, p2p=0, merchant=0, p2pVal=0;
    (txns||[]).forEach(tx => {
      const t = (tx.tx_type||'P2P').toUpperCase();
      if      (t==='CASH_IN')         cashin++;
      else if (t==='CASH_OUT')        cashout++;
      else if (t==='USSD_SELF_LOAD'||t==='NIP_SELF_LOAD') selfload++;
      else if (t==='MERCHANT')        merchant++;
      else { p2p++; p2pVal += tx.amount||0; }
    });

    // ── Commission ────────────────────────────────────────────
    if (section === 'commission') {
      const monthly = {};
      (commEvents||[]).forEach(e => {
        const month = (e.created_at||'').slice(0,7);
        if (!monthly[month]) monthly[month] = { fee:0, mfb:0, zil:0, agt:0, count:0 };
        const sl = !e.agent_id;
        monthly[month].fee   += e.fee_kobo||0;
        monthly[month].mfb   += e.mfb_kobo||0;
        monthly[month].zil   += sl ? (e.zillion_kobo||0)+(e.agent_kobo||0) : (e.zillion_kobo||0);
        monthly[month].agt   += sl ? 0 : (e.agent_kobo||0);
        monthly[month].count++;
      });
      return ok({ events: commEvents||[], monthly_breakdown: monthly });
    }

    // Commission totals
    let commFee=0, commMfb=0, commZil=0, commAgt=0;
    (commEvents||[]).forEach(e => {
      const sl = !e.agent_id;
      commFee += e.fee_kobo||0;
      commMfb += e.mfb_kobo||0;
      commZil += sl ? (e.zillion_kobo||0)+(e.agent_kobo||0) : (e.zillion_kobo||0);
      commAgt += sl ? 0 : (e.agent_kobo||0);
    });

    // ── Compliance alerts ─────────────────────────────────────
    const alerts = [];
    const cifRatio = vHeld > 0 && (agents||[]).length > 0
      ? vHeld / ((agents||[]).reduce((s,a)=>s+(a.float_balance_kobo||0),0)||vHeld)
      : 0;

    if (cifRatio > 0.85) alerts.push({ level:'HIGH', code:'CIF_CRITICAL', msg:'CIF ratio above 85% — float at risk', value: cifRatio });
    else if (cifRatio > 0.75) alerts.push({ level:'MEDIUM', code:'CIF_WARNING', msg:'CIF ratio above 75% — monitor closely', value: cifRatio });
    if (vRedeemed > vMinted * 0.9) alerts.push({ level:'MEDIUM', code:'HIGH_REDEMPTION', msg:'Over 90% of minted coins redeemed — consider topping up' });
    if ((agents||[]).filter(a=>a.status!=='ACTIVE').length > 0) {
      alerts.push({ level:'LOW', code:'INACTIVE_AGENTS', msg: (agents||[]).filter(a=>a.status!=='ACTIVE').length + ' agent(s) inactive' });
    }
    if (section === 'alerts') return ok({ alerts, cif_ratio: cifRatio });

    // ── Daily volumes (last 30 days) ──────────────────────────
    const daily = {};
    const thirtyAgo = new Date(Date.now()-30*86400000).toISOString().slice(0,10);
    (commEvents||[]).filter(e=>(e.created_at||'').slice(0,10)>=thirtyAgo).forEach(e=>{
      const d = (e.created_at||'').slice(0,10);
      if (!daily[d]) daily[d] = {fee:0, count:0};
      daily[d].fee   += e.fee_kobo||0;
      daily[d].count++;
    });

    // ── Full dashboard response ───────────────────────────────
    return ok({
      success:       true,
      generated_at:  new Date().toISOString(),
      partner: {
        mfb_id:        partner.mfb_id,
        mfb_name:      partner.mfb_name,
        state:         partner.state,
        tier:          partner.tier,
        licence_number:partner.licence_number,
        contact_name:  partner.contact_name,
        contact_email: partner.contact_email,
        status:        partner.status,
      },
      coin_metrics: {
        coins_minted: minted,    value_minted_kobo:  vMinted,
        coins_held:   held,      value_held_kobo:    vHeld,
        coins_issued: issued,    value_issued_kobo:  vIssued,
        coins_redeemed: redeemed,value_redeemed_kobo:vRedeemed,
        float_obligation_kobo:   vHeld,
        cif_ratio:    Math.round(cifRatio*1000)/1000,
      },
      transaction_counts: { cashin, cashout, selfload, p2p, merchant, p2p_value_kobo: p2pVal,
        total: cashin+cashout+selfload+p2p+merchant },
      commission: { fee_kobo: commFee, mfb_kobo: commMfb, zillion_kobo: commZil, agent_kobo: commAgt,
        event_count: (commEvents||[]).length },
      agents:      agents||[],
      agent_count: (agents||[]).length,
      recent_transactions: (txns||[]).slice(0,20),
      alerts,
      daily_volumes: daily,
    });
  } catch(e) {
    return err(500, e.message);
  }
};
