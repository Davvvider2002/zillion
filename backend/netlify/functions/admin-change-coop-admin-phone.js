/**
 * POST /api/v1/admin-change-coop-admin-phone
 * Body: { coop_id, new_phone, reason, new_password? }
 *
 * Lets Zillion staff change the mobile number a society was registered with (the society admin's login number), for example when the
 * admin has lost the SIM or handed the role to someone else.
 *
 * The society's merchant_id is kept as it is, because members, journals and payments all point at it. What changes is the phone stored on
 * the merchant and on the society. merchant-login and merchant-forgot-password look the merchant up by phone, so from this moment only
 * the NEW number signs in, and the new admin can use "Forgot password" to set their own password by SMS code.
 *
 * Auth: SUPER_ADMIN or OPERATIONS. Every change is audit logged with the old and new number and the reason given.
 */
'use strict';

const { createHmac } = require('crypto');
const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { auditLog }               = require('../../lib/auditLog');
const { cleanText }              = require('../../lib/cleanText');
const { resolveOrCreateZillionId } = require('../../lib/zillionId');
const { limitByKey, tooManyRequests } = require('../../lib/publicRateLimit');
const { derivedMerchantId, last10 } = require('../../lib/merchantLookup');

function normalisePhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('234')) return '+' + d;
  if (d.startsWith('0'))   return '+234' + d.slice(1);
  return '+234' + d;
}

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');
  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ['SUPER_ADMIN', 'OPERATIONS'])) return err(403, 'SUPER_ADMIN or OPERATIONS role required to change a society admin number');

  let body; try { body = JSON.parse(event.body || '{}'); } catch { return err(400, 'Invalid JSON'); }
  const coopId = cleanText(body.coop_id, 60);
  const reason = cleanText(body.reason, 300);
  const newPassword = body.new_password == null || body.new_password === '' ? null : String(body.new_password);
  if (!coopId) return err(400, 'coop_id is required');
  if (!body.new_phone) return err(400, 'new_phone is required');
  if (!reason || reason.length < 5) return err(400, 'Please give a reason for the change (it is kept in the audit log)');
  if (newPassword !== null && newPassword.length < 6) return err(400, 'new_password must be at least 6 characters');
  const newPhone = normalisePhone(body.new_phone);
  if (!/^\+\d{10,15}$/.test(newPhone)) return err(400, `Invalid phone number: "${newPhone}"`);

  const db = getServiceClient();
  const rl = await limitByKey(db, 'admin-change-coop-phone', auth.payload.username || auth.payload.sub || 'staff', { windowMinutes: 60, maxAttempts: 20, lockoutMinutes: 30 });
  if (!rl.allowed) return tooManyRequests(rl.retryAfterSeconds, 'number changes');

  const { data: society } = await db.from('coop_societies').select('coop_id, name, phone, merchant_id').eq('coop_id', coopId).maybeSingle();
  if (!society) return err(404, 'Society not found');
  const oldPhone = society.phone;
  if (last10(oldPhone) === last10(newPhone) && oldPhone === newPhone) return err(400, 'That is already the registered number');

  const { data: merchant } = await db.from('merchants').select('merchant_id, phone, zillion_id, password_hash').eq('merchant_id', society.merchant_id).maybeSingle();
  if (!merchant) return err(409, 'This society has no merchant login record to update');

  // The new number must not already belong to anyone who signs in: another merchant, another society's admin, or staff.
  const { data: phoneMerchants } = await db.from('merchants').select('merchant_id').eq('phone', newPhone).limit(2);
  if ((phoneMerchants || []).some(m => m.merchant_id !== society.merchant_id)) return err(409, 'That number is already registered to another merchant or society');
  const derived = derivedMerchantId(newPhone);
  if (derived !== society.merchant_id) {
    const { data: clash } = await db.from('merchants').select('merchant_id').eq('merchant_id', derived).maybeSingle();
    if (clash) return err(409, 'That number clashes with an existing merchant account (' + derived + '). Use a different number.');
  }
  const { data: otherSocieties } = await db.from('coop_societies').select('coop_id').eq('phone', newPhone).neq('coop_id', coopId).limit(1);
  if (otherSocieties && otherSocieties.length) return err(409, 'That number is already registered to another society: ' + otherSocieties[0].coop_id);
  const { data: staff } = await db.from('coop_portal_users').select('id').eq('phone', newPhone).limit(1);
  if (staff && staff.length) return err(409, 'That number belongs to a staff user of a society. Pick a number nobody else signs in with.');

  let zillionId = null;
  try { zillionId = await resolveOrCreateZillionId(db, newPhone, 'merchant'); }
  catch (e) { console.warn('[admin-change-coop-admin-phone] identity link failed (non-fatal):', e.message); }

  const before = { phone: merchant.phone, zillion_id: merchant.zillion_id, password_hash: merchant.password_hash };   // copied now, for the put-back below
  const merchantPatch = { phone: newPhone };
  if (zillionId) merchantPatch.zillion_id = zillionId;
  if (newPassword) merchantPatch.password_hash = createHmac('sha256', process.env.JWT_SECRET || '').update(newPassword).digest('hex');
  const { error: mErr } = await db.from('merchants').update(merchantPatch).eq('merchant_id', society.merchant_id);
  if (mErr) return err(500, 'Could not update the merchant record: ' + mErr.message);

  const { error: sErr } = await db.from('coop_societies').update({ phone: newPhone }).eq('coop_id', coopId);
  if (sErr) {
    await db.from('merchants').update(before).eq('merchant_id', society.merchant_id);   // put it back, never leave the two out of step
    return err(500, 'Could not update the society record: ' + sErr.message);
  }

  await auditLog(db, {
    action: 'COOP_ADMIN_PHONE_CHANGED',
    username: auth.payload.username || auth.payload.sub, role: auth.payload.role,
    ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_society', resourceId: coopId,
    requestBody: { old_phone: oldPhone, new_phone: newPhone, reason, password_reset: !!newPassword },
    result: 'SUCCESS',
  });

  return ok({ success: true, coop_id: coopId, old_phone: oldPhone, new_phone: newPhone, merchant_id: society.merchant_id,
    message: `The registered number for ${society.name} is now ${newPhone}. The old number can no longer sign in. ${newPassword ? 'The password was reset as given.' : 'The new admin can use "Forgot password" with the new number to set a password.'}` });
};
