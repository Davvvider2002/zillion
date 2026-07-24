'use strict';
/**
 * POST /api/v1/admin/commission-config  — create or update a config
 * GET  /api/v1/admin/commission-config  — list all active configs
 * DELETE /api/v1/admin/commission-config?id=UUID — deactivate a config
 *
 * Body (POST): {
 *   txn_type:       'cash_in'|'cash_out'|'p2p'|'merchant'
 *   scope:          'global'|'mfb'|'agent'
 *   scope_id:       string  (MFB ID or agent ID; null for global)
 *   fee_pct:        number  (e.g. 0.015 = 1.5%)
 *   fee_floor_kobo: number
 *   fee_cap_kobo:   number
 *   mfb_share_pct:  number  (e.g. 0.20)
 *   zillion_share_pct: number
 *   note:           string  (reason for change, audit trail)
 * }
 */

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: hdr, body: '' };

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid || auth.payload.role !== 'admin')
    return err(401, 'Admin auth required');

  const db = getServiceClient();

  // ── GET — list all configs ──────────────────────────────────
  if (event.httpMethod === 'GET') {
    const { data, error } = await db
      .from('commission_configs')
      .select('*')
      .order('txn_type')
      .order('scope')
      .order('effective_from', { ascending: false });
    if (error) return err(500, error.message);
    return ok({ configs: data || [] });
  }

  // ── DELETE — deactivate a config ────────────────────────────
  if (event.httpMethod === 'DELETE') {
    const id = (event.queryStringParameters || {}).id;
    if (!id) return err(400, 'id required');
    const { error } = await db.from('commission_configs')
      .update({ active: false, deactivated_by: auth.payload.sub,
                deactivated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) return err(500, error.message);
    return ok({ success: true, deactivated_id: id });
  }

  // ── POST — create or update ─────────────────────────────────
  if (event.httpMethod !== 'POST') return err(405, 'Method not allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return err(400, 'Invalid JSON'); }

  const { txn_type, scope, scope_id, fee_pct, fee_floor_kobo,
          fee_cap_kobo, mfb_share_pct, zillion_share_pct, note } = body;

  if (!txn_type || !scope)
    return err(400, 'txn_type and scope are required');
  if (!['cash_in','cash_out','p2p','merchant'].includes(txn_type))
    return err(400, 'txn_type must be cash_in|cash_out|p2p|merchant');
  if (!['global','mfb','agent'].includes(scope))
    return err(400, 'scope must be global|mfb|agent');
  if (mfb_share_pct + zillion_share_pct >= 1)
    return err(400, 'mfb_share + zillion_share must be < 1 (agent gets remainder)');

  const { data: inserted, error: insertErr } = await db
    .from('commission_configs')
    .insert({
      txn_type, scope,
      scope_id:         scope_id || null,
      fee_pct:          fee_pct,
      fee_floor_kobo:   fee_floor_kobo   || 1000,
      fee_cap_kobo:     fee_cap_kobo     || 20000,
      mfb_share_pct:    mfb_share_pct    || 0.20,
      zillion_share_pct:zillion_share_pct|| 0.30,
      note:             note || '',
      created_by:       auth.payload.sub,
      active:           true,
      effective_from:   new Date().toISOString(),
    })
    .select()
    .single();

  if (insertErr) return err(500, insertErr.message);
  return ok({ success: true, config: inserted,
               agent_share_pct: 1 - mfb_share_pct - zillion_share_pct });
};
