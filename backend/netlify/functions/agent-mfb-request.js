/**
 * GET  /api/v1/agent-mfb-request  — current MFB + any pending change request
 * POST /api/v1/agent-mfb-request  — submit a request to change MFB
 * Body (POST): { requested_mfb_id: string, reason?: string }
 *
 * Unlike wallet/merchant, an agent's MFB (agents.mfb_id) is a
 * contractual/regulatory assignment set at onboarding — not a casual
 * preference — so a change here does NOT take effect immediately. It
 * creates a row in agent_mfb_change_requests for admin review. Approving
 * or rejecting happens via admin-mfb-requests.js.
 *
 * Auth: agent JWT (agent_id in payload)
 */
'use strict';

const { createClient } = require('@supabase/supabase-js');
const { verifyJWT }    = require('../../lib/validators');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: hdr, body: '' };

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, auth.reason);

  const agentId = auth.payload.agent_id || auth.payload.sub;
  if (!agentId) return err(401, 'No agent identity on token');

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );

  if (event.httpMethod === 'GET') {
    const { data: agent } = await db.from('agents')
      .select('agent_id, mfb_id, mfb_name').eq('agent_id', agentId).maybeSingle();
    const { data: pending } = await db.from('agent_mfb_change_requests')
      .select('*').eq('agent_id', agentId).eq('status', 'PENDING')
      .order('requested_at', { ascending: false }).limit(1).maybeSingle();

    return ok({
      current_mfb_id:   agent?.mfb_id   || null,
      current_mfb_name: agent?.mfb_name || null,
      pending_request:  pending || null,
    });
  }

  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return err(400, 'Invalid JSON'); }
    const { requested_mfb_id, reason } = body;
    if (!requested_mfb_id) return err(400, 'requested_mfb_id is required');

    const { data: mfb } = await db.from('mfb_partners')
      .select('mfb_id, mfb_name, status').eq('mfb_id', requested_mfb_id).maybeSingle();
    if (!mfb || mfb.status !== 'ACTIVE') return err(400, 'Unknown or inactive MFB');

    const { data: agent } = await db.from('agents')
      .select('mfb_id, mfb_name').eq('agent_id', agentId).maybeSingle();

    if (agent?.mfb_id === requested_mfb_id) {
      return err(400, 'You are already assigned to this MFB');
    }

    // Only one pending request at a time per agent.
    const { data: existing } = await db.from('agent_mfb_change_requests')
      .select('request_id').eq('agent_id', agentId).eq('status', 'PENDING').maybeSingle();
    if (existing) return err(409, 'You already have a pending MFB change request');

    const { data: created, error: insErr } = await db.from('agent_mfb_change_requests').insert({
      agent_id:           agentId,
      current_mfb_id:     agent?.mfb_id   || null,
      current_mfb_name:   agent?.mfb_name || null,
      requested_mfb_id:   mfb.mfb_id,
      requested_mfb_name: mfb.mfb_name,
      reason:             reason || null,
    }).select().single();

    if (insErr) return err(500, insErr.message);

    return ok({ success: true, request: created });
  }

  return err(405, 'Method Not Allowed');
};
