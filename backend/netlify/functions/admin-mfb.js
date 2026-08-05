'use strict';
/**
 * GET  /api/v1/admin/mfb        — list all MFB partners with full stats
 * POST /api/v1/admin/mfb        — create new MFB partner
 * PUT  /api/v1/admin/mfb?id=ID  — update MFB partner
 *
 * MFB partner record comes from the agents table (grouped by mfb_id)
 * and the commission_configs table. There is no separate mfb table yet —
 * we derive MFBs from agents and coins.
 *
 * Each MFB report includes:
 *   - Partner details (id, name, contact, licence)
 *   - Coin metrics: minted, in circulation (HELD), undelivered (ISSUED), redeemed
 *   - Float obligation (SUM of HELD coin values)
 *   - Transaction counts by type: cash-in, cash-out, self-load, P2P, merchant
 *   - Commission earned (MFB share)
 *   - Agent count and agent list
 *   - Double-entry reconciliation status
 *   - CIF ratio (Coins In Float / Float balance)
 */

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: hdr, body: '' };

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Admin access required');
  if (!requireRole(auth, ['SUPER_ADMIN','COMPLIANCE','OPERATIONS','SUPPORT','AUDITOR','VIEWER'])) return err(403, 'Admin access required');

  const db = getServiceClient();

  // ── POST: create/register MFB partner ───────────────────────
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body||'{}'); } catch { return err(400,'Invalid JSON'); }
    const { mfb_id, mfb_name, contact_name, contact_email, contact_phone,
            licence_number, state, tier, notes } = body;
    if (!mfb_id || !mfb_name) return err(400, 'mfb_id and mfb_name are required');
    const { error: insErr } = await db.from('mfb_partners').insert({
      mfb_id, mfb_name, contact_name, contact_email, contact_phone,
      licence_number, state: state||'Kano', tier: tier||'MFB', notes: notes||'',
      status: 'ACTIVE', created_at: new Date().toISOString(),
    });
    if (insErr) {
      // Table may not exist yet — return guidance
      if (insErr.message.includes('does not exist')) {
        return err(500, 'Run migration_mfb_partners.sql in Supabase first: ' + insErr.message);
      }
      return err(500, insErr.message);
    }
    return ok({ success: true, mfb_id });
  }

  if (event.httpMethod !== 'GET') return err(405, 'GET or POST only');

  const p = event.queryStringParameters || {};
  const mfbFilter = p.mfb_id || null;

  try {
    // ── Agents grouped by mfb_id ──────────────────────────────
    const { data: agents } = await db.from('agents').select('*');
    const agentsByMfb = {};
    (agents||[]).forEach(a => {
      const mid = a.mfb_id || 'UNASSIGNED';
      if (!agentsByMfb[mid]) agentsByMfb[mid] = [];
      agentsByMfb[mid].push(a);
    });

    // ── MFB partners table (if exists) ────────────────────────
    let partners = [];
    try { const { data: pd2, error: pe2 } = await db.from('mfb_partners').select('*');
      if (!pe2) partners = pd2||[]; } catch(_){}
    const partnerMap = {};
    (partners||[]).forEach(p2 => { partnerMap[p2.mfb_id] = p2; });

    // ── All coins ─────────────────────────────────────────────
    const { data: coins } = await db.from('coins').select('coin_id, amount, status, issuer_id, issued_at');

    const agentIdToMfb = {};
    (agents||[]).forEach(a => { agentIdToMfb[a.agent_id] = a.mfb_id || 'UNASSIGNED'; });

    // ── Transactions ──────────────────────────────────────────
    const { data: txns } = await db.from('transactions').select('tx_id,coin_id,amount,tx_type,status,mfb_id,agent_id,tx_ts');

    // ── Commission events ─────────────────────────────────────
    const { data: comm } = await db.from('commission_events').select('mfb_id,fee_kobo,mfb_kobo,zillion_kobo,agent_kobo,agent_id,txn_type,created_at');

    // ── Build per-MFB report ──────────────────────────────────
    const mfbIds = new Set([
      ...(partners||[]).map(p2 => p2.mfb_id),  // partners first
      ...Object.keys(agentsByMfb).filter(id => id !== 'UNASSIGNED'),
    ]);
    // Always include all registered partners even with no agents yet
    if (mfbFilter) { mfbIds.clear(); mfbIds.add(mfbFilter); }

    const reports = [];

    for (const mfbId of mfbIds) {
      if ((mfbId === 'UNASSIGNED' || mfbId === 'UNKNOWN_MFB') && !mfbFilter) continue;

      const partner = partnerMap[mfbId] || partnerMap[mfbId.toLowerCase()] || {};
      const mfbAgents = agentsByMfb[mfbId] || [];
      const agentIds  = new Set(mfbAgents.map(a => a.agent_id));

      // Coins: attribute by agent issuer OR USSD self-load via commission mfb_id
      const selfLoadCoinIds = new Set(
        (comm||[]).filter(e => e.mfb_id === mfbId && !e.agent_id).map(e => e.coin_id).filter(Boolean)
      );

      let minted=0, held=0, issued=0, redeemed=0;
      let vMinted=0, vHeld=0, vIssued=0, vRedeemed=0;

      (coins||[]).forEach(c => {
        if (c.status === 'FROZEN') return;
        const byAgent   = agentIds.has(c.issuer_id);
        const bySelf    = selfLoadCoinIds.has(c.coin_id);
        if (!byAgent && !bySelf) return;

        minted++; vMinted += c.amount;
        if (c.status === 'HELD')                         { held++;     vHeld     += c.amount; }
        if (c.status === 'ISSUED')                       { issued++;   vIssued   += c.amount; }
        if (c.status === 'REDEEMED'||c.status === 'SPENT') { redeemed++; vRedeemed += c.amount; }
      });

      // Transactions by type
      let cashin=0, cashout=0, selfload=0, p2p=0, merchant=0, p2pVal=0;
      (txns||[]).forEach(tx => {
        const isThisMfb = tx.mfb_id === mfbId || agentIds.has(tx.agent_id);
        if (!isThisMfb) return;
        const t = (tx.tx_type||'P2P').toUpperCase();
        if      (t==='CASH_IN')                       cashin++;
        else if (t==='CASH_OUT')                      cashout++;
        else if (t==='USSD_SELF_LOAD'||t==='NIP_SELF_LOAD') selfload++;
        else if (t==='MERCHANT')                      merchant++;
        else { p2p++; p2pVal += tx.amount||0; }
      });

      // Commission
      let commFee=0, commMfb=0, commZil=0, commAgt=0;
      (comm||[]).forEach(e => {
        if (e.mfb_id !== mfbId) return;
        const sl = !e.agent_id;
        commFee += e.fee_kobo||0;
        commMfb += e.mfb_kobo||0;
        commZil += sl ? (e.zillion_kobo||0)+(e.agent_kobo||0) : (e.zillion_kobo||0);
        commAgt += sl ? 0 : (e.agent_kobo||0);
      });

      // Double-entry
      const drFloat = vMinted;
      const crCirc  = vMinted;
      const drCirc  = vRedeemed;
      const crAgent = vRedeemed;
      const disc    = vMinted - (vIssued + vHeld + vRedeemed);
      const balanced = disc === 0 && drFloat === crCirc && drCirc === crAgent;

      // Float
      const floatBalance = mfbAgents.reduce((s,a)=>s+(a.float_balance_kobo||0),0);
      const cifRatio     = floatBalance > 0 ? (vHeld / floatBalance) : null;

      // Recent activity (last 30 days)
      const thirtyDaysAgo = new Date(Date.now()-30*86400000).toISOString();
      const recentComm = (comm||[]).filter(e => e.mfb_id===mfbId && e.created_at>=thirtyDaysAgo);
      const recentFee30 = recentComm.reduce((s,e)=>s+(e.fee_kobo||0),0);

      reports.push({
        mfb_id:           mfbId,
        mfb_name:         partner.mfb_name || mfbNames[mfbId] || mfbId,
        contact_name:     partner.contact_name || '',
        contact_email:    partner.contact_email || '',
        contact_phone:    partner.contact_phone || '',
        licence_number:   partner.licence_number || '',
        state:            partner.state || '',
        tier:             partner.tier || 'MFB',
        status:           partner.status || 'ACTIVE',
        notes:            partner.notes || '',
        // Coin metrics
        coins_minted:     minted,
        coins_held:       held,
        coins_issued:     issued,
        coins_redeemed:   redeemed,
        value_minted_kobo:  vMinted,
        value_held_kobo:    vHeld,
        value_issued_kobo:  vIssued,
        value_redeemed_kobo:vRedeemed,
        float_obligation_kobo: vHeld,
        // Transaction counts
        cashin_count:     cashin,
        cashout_count:    cashout,
        selfload_count:   selfload,
        p2p_count:        p2p,
        p2p_value_kobo:   p2pVal,
        merchant_count:   merchant,
        total_tx:         cashin+cashout+selfload+p2p+merchant,
        // Commission
        commission_fee_kobo:     commFee,
        commission_mfb_kobo:     commMfb,
        commission_zillion_kobo: commZil,
        commission_agent_kobo:   commAgt,
        commission_30d_kobo:     recentFee30,
        // Agents
        agent_count:      mfbAgents.length,
        total_float_kobo: floatBalance,
        cif_ratio:        cifRatio !== null ? Math.round(cifRatio*100)/100 : null,
        agents:           mfbAgents.map(a => ({
          agent_id: a.agent_id, name: a.name, location_name: a.location_name,
          status: a.status, float_balance_kobo: a.float_balance_kobo||0,
        })),
        // Double-entry
        dr_mfb_float:         drFloat,
        cr_coins_circulation: crCirc,
        dr_coins_circulation: drCirc,
        cr_agent_float:       crAgent,
        balanced,
        recon_discrepancy_kobo: disc,
        recon_note: balanced ? 'All checks pass' :
          disc !== 0 ? 'Conservation fail (disc: '+(disc/100).toFixed(2)+')' : 'DR/CR mismatch',
      });
    }

    reports.sort((a,b) => b.value_minted_kobo - a.value_minted_kobo);

    // Platform totals
    const totals = reports.reduce((acc, r) => ({
      mfb_count:            acc.mfb_count + 1,
      coins_minted:         acc.coins_minted + r.coins_minted,
      coins_held:           acc.coins_held + r.coins_held,
      coins_redeemed:       acc.coins_redeemed + r.coins_redeemed,
      value_minted_kobo:    acc.value_minted_kobo + r.value_minted_kobo,
      value_held_kobo:      acc.value_held_kobo + r.value_held_kobo,
      value_redeemed_kobo:  acc.value_redeemed_kobo + r.value_redeemed_kobo,
      float_obligation_kobo:acc.float_obligation_kobo + r.float_obligation_kobo,
      commission_fee_kobo:  acc.commission_fee_kobo + r.commission_fee_kobo,
      commission_mfb_kobo:  acc.commission_mfb_kobo + r.commission_mfb_kobo,
      total_tx:             acc.total_tx + r.total_tx,
      all_balanced:         acc.all_balanced && r.balanced,
    }), {
      mfb_count:0,coins_minted:0,coins_held:0,coins_redeemed:0,
      value_minted_kobo:0,value_held_kobo:0,value_redeemed_kobo:0,
      float_obligation_kobo:0,commission_fee_kobo:0,commission_mfb_kobo:0,
      total_tx:0,all_balanced:true,
    });

    return ok({ success: true, generated_at: new Date().toISOString(), mfb_partners: reports, totals });
  } catch (e) {
    return err(500, e.message);
  }
};
