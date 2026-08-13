/**
 * GET  /api/v1/admin/mfb-requests            — list requests (default: PENDING only)
 * POST /api/v1/admin/mfb-requests             — approve or reject a request
 * Body (POST): { request_id, action: 'APPROVE'|'REJECT', notes? }
 *
 * Approving updates agents.mfb_id/mfb_name to the requested MFB.
 * Rejecting just marks the request REJECTED — the agent's current
 * assignment is untouched either way until an APPROVE happens.
 *
 * Auth: admin JWT
 */
'use strict';

const { corsOrigin } = require('../../lib/cors');

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { auditLog } = require('../../lib/auditLog');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin(event) };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: hdr, body: '' };

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Admin access required');
  if (!requireRole(auth, ['SUPER_ADMIN', 'COMPLIANCE', 'OPERATIONS'])) return err(403, 'Insufficient role for MFB approvals');

  const db = getServiceClient();

  if (event.httpMethod === 'GET') {
    const statusFilter = (event.queryStringParameters || {}).status || 'PENDING';
    let q = db.from('agent_mfb_change_requests').select('*').order('requested_at', { ascending: false });
    if (statusFilter !== 'ALL') q = q.eq('status', statusFilter);
    const { data, error } = await q;
    if (error) return err(500, error.message);
    return ok({ requests: data || [] });
  }

  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return err(400, 'Invalid JSON'); }
    const { request_id, action, notes } = body;
    if (!request_id || !['APPROVE', 'REJECT'].includes(action)) {
      return err(400, 'request_id and action (APPROVE|REJECT) are required');
    }

    const { data: reqRow } = await db.from('agent_mfb_change_requests')
      .select('*').eq('request_id', request_id).maybeSingle();
    if (!reqRow) return err(404, 'Request not found');
    if (reqRow.status !== 'PENDING') return err(409, `Request already ${reqRow.status}`);

    if (action === 'APPROVE') {
      const { error: agUpdErr } = await db.from('agents').update({
        mfb_id:   reqRow.requested_mfb_id,
        mfb_name: reqRow.requested_mfb_name,
      }).eq('agent_id', reqRow.agent_id);
      if (agUpdErr) return err(500, agUpdErr.message);
    }

    const { error: reqUpdErr } = await db.from('agent_mfb_change_requests').update({
      status:        action === 'APPROVE' ? 'APPROVED' : 'REJECTED',
      reviewed_at:   new Date().toISOString(),
      reviewed_by:   auth.payload.sub || auth.payload.username || 'admin',
      review_notes:  notes || null,
    }).eq('request_id', request_id);
    if (reqUpdErr) return err(500, reqUpdErr.message);

    await auditLog(db, {
      action:       `MFB_REQUEST_${action === 'APPROVE' ? 'APPROVED' : 'REJECTED'}`,
      username:     auth.payload.username || auth.payload.sub,
      role:         auth.payload.role,
      ip:           event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
      resourceType: 'agent_mfb_change_request',
      resourceId:   request_id,
      requestBody:  { agent_id: reqRow.agent_id, requested_mfb_id: reqRow.requested_mfb_id, notes },
      result:       'SUCCESS',
    });

    return ok({ success: true, action, request_id });
  }

  return err(405, 'Method Not Allowed');
};
