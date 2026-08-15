/**
 * zillion/backend/netlify/functions/admin-cooperative-members.js
 *
 * GET    /api/v1/admin-cooperative-members?coop_id=X  — list members
 * POST   /api/v1/admin-cooperative-members             — add a member by phone
 * DELETE /api/v1/admin-cooperative-members             — remove a member
 *
 * Members are looked up by phone number and converted to holder_hash
 * server-side using the same scheme the wallet itself computes
 * (plain SHA256(normalised_phone)) — matching bank-fund-customer-wallet.js's
 * approach, so a member's aggregated stats line up correctly with their
 * actual wallet identity.
 */
'use strict';

const crypto = require('crypto');
const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { auditLog }               = require('../../lib/auditLog');

function normalisePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('234')) return '+' + digits;
  if (digits.startsWith('0'))   return '+234' + digits.slice(1);
  return '+' + digits;
}

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ['SUPER_ADMIN','COMPLIANCE','OPERATIONS','SUPPORT','AUDITOR','VIEWER']))
    return err(403, 'Admin access required');

  const db = getServiceClient();

  if (event.httpMethod === 'GET') {
    const coopId = (event.queryStringParameters || {}).coop_id;
    if (!coopId) return err(400, 'coop_id query parameter required');
    const { data, error } = await db
      .from('cooperative_members')
      .select('*')
      .eq('coop_id', coopId)
      .order('added_at', { ascending: false });
    if (error) return err(500, error.message);
    return ok({ members: data || [] });
  }

  if (event.httpMethod === 'POST') {
    if (!requireRole(auth, ['SUPER_ADMIN','OPERATIONS']))
      return err(403, 'SUPER_ADMIN or OPERATIONS role required to manage cooperative membership');

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return err(400, 'Invalid JSON'); }

    const coopId      = (body.coop_id || '').trim();
    const rawPhone     = (body.phone || '').trim();
    const memberName  = (body.member_name || '').trim() || null;

    if (!coopId)  return err(400, 'coop_id is required');
    if (!rawPhone) return err(400, 'phone is required');

    const { data: coop } = await db.from('cooperatives').select('coop_id, status').eq('coop_id', coopId).single();
    if (!coop) return err(400, `Unknown coop_id: ${coopId}`);
    if (coop.status !== 'ACTIVE') return err(400, `Cooperative is not active (status: ${coop.status})`);

    const phone      = normalisePhone(rawPhone);
    if (!/^\+\d{10,15}$/.test(phone)) return err(400, `Invalid phone number: "${phone}"`);
    const holderHash = crypto.createHash('sha256').update(phone).digest('hex');

    const { data: created, error: insertErr } = await db
      .from('cooperative_members')
      .insert({
        coop_id: coopId, holder_hash: holderHash, member_name: memberName, member_phone: phone,
        added_by: auth.payload.username || auth.payload.sub,
      })
      .select().single();
    if (insertErr) {
      if (insertErr.code === '23505') return err(409, 'This phone number is already a member of this cooperative');
      return err(500, `Failed to add member: ${insertErr.message}`);
    }

    await auditLog(db, {
      action:       'COOPERATIVE_MEMBER_ADDED',
      username:     auth.payload.username || auth.payload.sub,
      role:         auth.payload.role,
      ip:           event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
      resourceType: 'cooperative_member',
      resourceId:   coopId,
      requestBody:  { coop_id: coopId, phone, member_name: memberName },
      result:       'SUCCESS',
    });

    return ok({ success: true, member: created });
  }

  if (event.httpMethod === 'DELETE') {
    if (!requireRole(auth, ['SUPER_ADMIN','OPERATIONS']))
      return err(403, 'SUPER_ADMIN or OPERATIONS role required to manage cooperative membership');

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return err(400, 'Invalid JSON'); }

    const memberId = (body.member_id || '').trim();
    if (!memberId) return err(400, 'member_id is required');

    const { data: removed, error: delErr } = await db
      .from('cooperative_members')
      .delete()
      .eq('id', memberId)
      .select().single();
    if (delErr) return err(500, delErr.message);

    await auditLog(db, {
      action:       'COOPERATIVE_MEMBER_REMOVED',
      username:     auth.payload.username || auth.payload.sub,
      role:         auth.payload.role,
      ip:           event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
      resourceType: 'cooperative_member',
      resourceId:   removed ? removed.coop_id : memberId,
      requestBody:  { member_id: memberId },
      result:       'SUCCESS',
    });

    return ok({ success: true });
  }

  return err(405, 'Method Not Allowed');
};
