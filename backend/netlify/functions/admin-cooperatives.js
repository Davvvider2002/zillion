/**
 * zillion/backend/netlify/functions/admin-cooperatives.js
 *
 * GET  /api/v1/admin-cooperatives          — list all cooperatives
 * POST /api/v1/admin-cooperatives          — create a new cooperative
 *
 * A cooperative is a group of farmers selling together — admin-managed,
 * not self-enrolled. This endpoint only handles the cooperative record
 * itself; membership is managed via admin-cooperative-members.js.
 */
'use strict';

const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { auditLog }               = require('../../lib/auditLog');

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
    const { data, error } = await db
      .from('cooperatives')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) return err(500, error.message);

    // Attach a member count per cooperative — cheap enough to do inline
    // for the list view rather than requiring a second round-trip.
    const { data: memberCounts } = await db
      .from('cooperative_members')
      .select('coop_id');
    const counts = {};
    (memberCounts || []).forEach(m => { counts[m.coop_id] = (counts[m.coop_id] || 0) + 1; });

    const coops = (data || []).map(c => ({ ...c, member_count: counts[c.coop_id] || 0 }));
    return ok({ cooperatives: coops });
  }

  if (event.httpMethod === 'POST') {
    if (!requireRole(auth, ['SUPER_ADMIN','OPERATIONS']))
      return err(403, 'SUPER_ADMIN or OPERATIONS role required to create cooperatives');

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return err(400, 'Invalid JSON'); }

    const name         = (body.name || '').trim();
    const location     = (body.location || '').trim() || null;
    const contactName  = (body.contact_name || '').trim() || null;
    const contactPhone = (body.contact_phone || '').trim() || null;

    if (!name) return err(400, 'name is required');

    const { data: created, error: insertErr } = await db
      .from('cooperatives')
      .insert({
        name, location, contact_name: contactName, contact_phone: contactPhone,
        created_by: auth.payload.username || auth.payload.sub,
      })
      .select().single();
    if (insertErr) return err(500, `Failed to create cooperative: ${insertErr.message}`);

    await auditLog(db, {
      action:       'COOPERATIVE_CREATED',
      username:     auth.payload.username || auth.payload.sub,
      role:         auth.payload.role,
      ip:           event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
      resourceType: 'cooperative',
      resourceId:   created.coop_id,
      requestBody:  { name, location, contact_name: contactName, contact_phone: contactPhone },
      result:       'SUCCESS',
    });

    return ok({ success: true, cooperative: created });
  }

  return err(405, 'Method Not Allowed');
};
