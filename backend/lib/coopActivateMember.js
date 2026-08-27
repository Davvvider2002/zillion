/**
 * zillion/backend/lib/coopActivateMember.js
 *
 * Core member-activation logic, extracted from
 * coop-activate-member.js so bulk import (admin-coop-bulk-import.js)
 * can reuse the exact same identity-resolution and wallet
 * pre-provisioning logic, rather than duplicating it — any future fix
 * only needs to happen here, not in two places that could drift apart.
 *
 * Returns a result object rather than throwing on expected outcomes
 * (already-a-member, invalid phone) — callers (both single and bulk)
 * decide how to present that, since a bulk import needs to keep going
 * on one bad row, not abort the whole batch.
 */
'use strict';

const { createHmac } = require('crypto');
const { resolveOrCreateZillionId } = require('./zillionId');
const { computeWalletDeviceHash }  = require('./crypto');

function normalisePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('234')) return '+' + digits;
  if (digits.startsWith('0'))   return '+234' + digits.slice(1);
  return '+' + digits;
}

/**
 * @param {object} db  Supabase client
 * @param {object} params { coopId, rawPhone, name, openingBalanceKobo, activatedBy }
 * @returns {Promise<{ok: boolean, status: 'created'|'already_existed'|'error', member?, error?, phone?}>}
 */
async function activateMember(db, { coopId, rawPhone, name, openingBalanceKobo, activatedBy }) {
  if (!rawPhone) return { ok: false, status: 'error', error: 'phone is required' };
  if (openingBalanceKobo < 0) return { ok: false, status: 'error', error: 'opening balance cannot be negative' };

  const phone = normalisePhone(rawPhone);
  if (!/^\+\d{10,15}$/.test(phone)) return { ok: false, status: 'error', error: `Invalid phone number: "${phone}"`, phone };

  const { data: existingMember } = await db.from('coop_members')
    .select('*').eq('coop_id', coopId).eq('phone_normalized', phone).maybeSingle();
  if (existingMember) return { ok: true, status: 'already_existed', member: existingMember, phone };

  let zillionId = null;
  try { zillionId = await resolveOrCreateZillionId(db, phone, 'coop_member'); }
  catch (e) { console.warn('[coopActivateMember] zillion identity link failed (non-fatal):', e.message); }

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
          public_key_hex:   'COOP_ACTIVATED',
          registered_at:    new Date().toISOString(),
          status:           'ACTIVE',
          zillion_id:       zillionId,
        });
      } else if (zillionId) {
        await db.from('devices').update({ zillion_id: zillionId })
          .eq('device_hash', existingDevice[0].device_hash).is('zillion_id', null);
      }
    } catch (e) { console.warn('[coopActivateMember] wallet pre-provision failed (non-fatal):', e.message); }
  }

  const { data: created, error: insertErr } = await db.from('coop_members').insert({
    coop_id:              coopId,
    zillion_id:           zillionId,
    phone_normalized:     phone,
    name:                 name || null,
    opening_balance_kobo: openingBalanceKobo || 0,
    activated_by:         activatedBy,
  }).select().single();

  if (insertErr) return { ok: false, status: 'error', error: insertErr.message, phone };

  return { ok: true, status: 'created', member: created, phone };
}

module.exports = { activateMember, normalisePhone };
