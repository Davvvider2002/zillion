/**
 * zillion/backend/netlify/functions/coop-activate-member.js
 *
 * POST /api/v1/coop-activate-member
 *
 * Cooperative society admin activates a member by phone number —
 * including someone who has NEVER opened Zillion before. This
 * pre-provisions their wallet identity (opening balance, phone-linked
 * unified Zillion ID) so that when they eventually download the app
 * and verify that same phone number, it resolves straight to the
 * identity already waiting for them.
 *
 * Mirrors bank-activate-customer.js's pattern, but with a real,
 * previously-existing bug fixed along the way: that endpoint's
 * pre-provisioned devices.device_hash used a different formula (HMAC
 * of phone) than what verify-otp.js computes on a real login (SHA256
 * of phone+key, truncated) — meaning the two would never match, and
 * pre-set data was silently orphaned the moment someone actually
 * logged in for real. This endpoint uses the correct, shared formula
 * from day one (crypto.js's computeWalletDeviceHash), and
 * bank-activate-customer.js has been fixed to match.
 *
 * Auth: Zillion admin (SUPER_ADMIN or OPERATIONS) — this is an
 * internal admin action for now; the dedicated coop web portal will
 * call through to this same endpoint once built.
 *
 * Body: { coop_id, phone, name, opening_balance_kobo? }
 */
'use strict';

const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { auditLog }               = require('../../lib/auditLog');
const { resolveOrCreateZillionId } = require('../../lib/zillionId');
const { computeWalletDeviceHash }  = require('../../lib/crypto');
const { createHmac } = require('crypto');

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
    return err(403, 'SUPER_ADMIN or OPERATIONS role required to activate cooperative members');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const coopId          = (body.coop_id || '').trim();
  const rawPhone         = (body.phone || '').trim();
  const name             = (body.name || '').trim();
  const openingBalance   = Number.isInteger(body.opening_balance_kobo) ? body.opening_balance_kobo : 0;

  if (!coopId)   return err(400, 'coop_id is required');
  if (!rawPhone) return err(400, 'phone is required');
  if (openingBalance < 0) return err(400, 'opening_balance_kobo cannot be negative');

  const phone = normalisePhone(rawPhone);
  if (!/^\+\d{10,15}$/.test(phone)) return err(400, `Invalid phone number: "${phone}"`);

  const db = getServiceClient();

  const { data: coop } = await db.from('coop_societies').select('coop_id, name, status').eq('coop_id', coopId).single();
  if (!coop) return err(400, `Unknown coop_id: ${coopId}`);
  if (coop.status === 'SUSPENDED') return err(403, `${coop.name}'s access is currently suspended`);

  // Already a member of this specific society?
  const { data: existingMember } = await db.from('coop_members')
    .select('id').eq('coop_id', coopId).eq('phone_normalized', phone).maybeSingle();
  if (existingMember) return err(409, 'This phone number is already an active member of this cooperative society');

  // Resolve/create the unified Zillion identity for this phone — links
  // this membership to the same identity as any existing wallet,
  // merchant, or agent record sharing this phone number.
  let zillionId = null;
  try { zillionId = await resolveOrCreateZillionId(db, phone, 'coop_member'); }
  catch (e) { console.warn('[coop-activate-member] zillion identity link failed (non-fatal):', e.message); }

  // Pre-provision a wallet identity if this phone has never touched
  // Zillion before — same trust model as bank-activate-customer.js
  // (the coop admin has already identified this real person), but using
  // the CORRECT device_hash formula so it actually resolves on first login.
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (serviceKey) {
    try {
      const phoneHashHmac = createHmac('sha256', serviceKey).update(phone).digest('hex');
      const deviceHash    = computeWalletDeviceHash(phone, serviceKey);
      const { data: existingDevice } = await db.from('devices')
        .select('device_hash').eq('phone_hash', phoneHashHmac).limit(1);
      if (!existingDevice || existingDevice.length === 0) {
        await db.from('devices').insert({
          device_hash:      deviceHash,
          phone_hash:       phoneHashHmac,
          public_key_hex:   'COOP_ACTIVATED',  // set for real when they first open the wallet
          registered_at:    new Date().toISOString(),
          status:           'ACTIVE',
          zillion_id:       zillionId,
        });
      } else if (zillionId) {
        // Already had a wallet identity — just make sure it's linked.
        await db.from('devices').update({ zillion_id: zillionId })
          .eq('device_hash', existingDevice[0].device_hash).is('zillion_id', null);
      }
    } catch (e) { console.warn('[coop-activate-member] wallet pre-provision failed (non-fatal):', e.message); }
  }

  const { data: created, error: insertErr } = await db.from('coop_members').insert({
    coop_id:              coopId,
    zillion_id:           zillionId,
    phone_normalized:     phone,
    name:                 name || null,
    opening_balance_kobo: openingBalance,
    activated_by:         auth.payload.username || auth.payload.sub,
  }).select().single();

  if (insertErr) return err(500, `Failed to activate member: ${insertErr.message}`);

  await auditLog(db, {
    action:       'COOP_MEMBER_ACTIVATED',
    username:     auth.payload.username || auth.payload.sub,
    role:         auth.payload.role,
    ip:           event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_member',
    resourceId:   coopId,
    requestBody:  { coop_id: coopId, phone, name, opening_balance_kobo: openingBalance },
    result:       'SUCCESS',
  });

  return ok({
    success: true,
    member:  created,
    message: zillionId
      ? `${name || phone} activated — will resolve automatically to this identity on their first wallet login.`
      : `${name || phone} activated, though identity linking had an issue — check manually.`,
  });
};
