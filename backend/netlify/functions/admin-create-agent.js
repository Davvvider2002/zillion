/**
 * POST /api/v1/admin-create-agent
 *
 * Creates a new agent. Previously there was no way to do this at all —
 * the admin panel's "agent" dropdown was hardcoded to 5 fixed demo
 * names, never actually backed by a create flow.
 *
 * MFB assignment is REQUIRED, not optional — per Zillion's architecture,
 * an agent works directly with/in relation to a specific participating
 * bank; this is enforced server-side, not just left to the UI.
 *
 * Auth: SUPER_ADMIN or OPERATIONS (onboarding a real agent is a
 * meaningful action, same tier as float top-ups).
 * Body: { name, phone, mfb_id, location_name? }
 */
'use strict';

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

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ['SUPER_ADMIN', 'OPERATIONS']))
    return err(403, 'SUPER_ADMIN or OPERATIONS role required to create agents');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const name          = (body.name || '').trim();
  const rawPhone       = (body.phone || '').trim();
  const mfbId          = (body.mfb_id || '').trim();
  const locationName   = (body.location_name || '').trim() || null;

  if (!name)   return err(400, 'name is required');
  if (!rawPhone) return err(400, 'phone is required');
  if (!mfbId) return err(400, 'mfb_id is required — every agent must be linked to a participating bank');

  const phone = normalisePhone(rawPhone);
  if (!/^\+\d{10,15}$/.test(phone))
    return err(400, `Invalid phone number: "${phone}"`);

  const db = getServiceClient();

  // MFB must be a real, active partner — not just any string the caller sends.
  const { data: mfb, error: mfbErr } = await db
    .from('mfb_partners')
    .select('mfb_id, mfb_name, status')
    .eq('mfb_id', mfbId)
    .single();
  if (mfbErr || !mfb) return err(400, `Unknown mfb_id: ${mfbId}`);
  if (mfb.status !== 'ACTIVE') return err(400, `${mfb.mfb_name} is not an active partner (status: ${mfb.status})`);

  // Phone uniqueness — agents.phone has a UNIQUE constraint at the DB
  // level too, but check first for a clean error instead of a raw
  // constraint-violation message.
  const { data: existingPhone } = await db.from('agents').select('agent_id').eq('phone', phone).limit(1);
  if (existingPhone && existingPhone.length > 0)
    return err(409, `An agent with phone ${phone} already exists (${existingPhone[0].agent_id})`);

  // Generate the next sequential agent_id (AGENT-00001, AGENT-00002, ...)
  const { data: lastAgent } = await db
    .from('agents')
    .select('agent_id')
    .order('agent_id', { ascending: false })
    .limit(1);
  let nextNum = 1;
  if (lastAgent && lastAgent.length > 0) {
    const m = lastAgent[0].agent_id.match(/AGENT-(\d+)/);
    if (m) nextNum = parseInt(m[1], 10) + 1;
  }
  const agentId = 'AGENT-' + String(nextNum).padStart(5, '0');

  const { data: created, error: insertErr } = await db.from('agents').insert({
    agent_id:           agentId,
    name,
    phone,
    location_name:      locationName,
    float_balance_kobo: 0,
    status:              'ACTIVE',
    mfb_id:              mfb.mfb_id,
    mfb_name:            mfb.mfb_name,
    onboarded_at:        new Date().toISOString(),
  }).select().single();

  if (insertErr) return err(500, `Failed to create agent: ${insertErr.message}`);

  await auditLog(db, {
    action:       'AGENT_CREATED',
    username:     auth.payload.username || auth.payload.sub,
    role:         auth.payload.role,
    ip:           event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'agent',
    resourceId:   agentId,
    requestBody:  { name, phone, mfb_id: mfb.mfb_id, mfb_name: mfb.mfb_name, location_name: locationName },
    result:       'SUCCESS',
  });

  return ok({ success: true, agent: created });
};
