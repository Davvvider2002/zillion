/**
 * zillion/backend/lib/memberPhoneChange.js
 *
 * Shared rules for the member wallet number change feature.
 *
 * What a member's number is linked to:
 *   zillion_identities.phone_normalized   the person, one row per number
 *   coop_members.phone_normalized         one row per society the person belongs to (all share the same zillion_id)
 *   devices.phone_hash                    HMAC of the number. recover-coins finds a wallet's coins through it
 *
 * Approving a change moves all three to the new number, so the person keeps every society membership and every coin. The coins are not
 * touched: they stay under their existing holder hashes, and recover-coins (which looks devices up by phone_hash) finds them again from
 * the new number. Anything that fails part way is put back before the error is returned.
 *
 * Deliberately NOT changed: society admin and staff logins (merchants.phone, coop_portal_users.phone). Those are separate records with their
 * own change routes, and silently moving a staff login because a wallet number moved would be a surprise. The impact preview warns instead.
 */
'use strict';

const { createHmac, createHash, randomBytes, timingSafeEqual } = require('crypto');

const digits = p => String(p == null ? '' : p).replace(/\D/g, '');
const last10 = p => digits(p).slice(-10);

function normalisePhone(raw) {
  const d = digits(raw);
  if (d.startsWith('234')) return '+' + d;
  if (d.startsWith('0'))   return '+234' + d.slice(1);
  return '+234' + d;
}
const isValidPhone = p => /^\+\d{10,15}$/.test(p);

const LINK_DAYS = 7;
const OPEN_STATUSES = ['LINK_SENT', 'SUBMITTED', 'MORE_PROOF_REQUESTED'];

function newToken() { return randomBytes(32).toString('base64url'); }
function hashToken(t) { return createHash('sha256').update(String(t || '')).digest('hex'); }
function expiryFromNow(days = LINK_DAYS) { return new Date(Date.now() + days * 24 * 3600 * 1000).toISOString(); }

function phoneHmac(phone, serviceKey) { return createHmac('sha256', serviceKey).update(phone).digest('hex'); }
function maskPhone(p) { const d = digits(p); return d.length < 4 ? '' : '••••••' + d.slice(-3); }

/**
 * Is the new number free to take? Returns { ok:true, staleIdentityId? } or { ok:false, reason }.
 * A number counts as taken if it is already a member of any society, is the login of a society admin or staff user, or has any wallet
 * (device), merchant or agent record. A bare identity row that nothing points at is stale and is removed on approval.
 */
async function checkNewNumberFree(db, newPhone, ownZillionId, serviceKey) {
  const taken = { ok: false, reason: 'That number is already registered on Zillion. Use a different number, or contact support.' };

  const { data: mem } = await db.from('coop_members').select('id').eq('phone_normalized', newPhone).limit(1);
  if (mem && mem.length) return taken;

  const { data: mer } = await db.from('merchants').select('merchant_id').eq('phone', newPhone).limit(1);
  if (mer && mer.length) return taken;
  const { data: staff } = await db.from('coop_portal_users').select('id').eq('phone', newPhone).limit(1);
  if (staff && staff.length) return taken;

  if (serviceKey) {
    const { data: dev } = await db.from('devices').select('device_hash').eq('phone_hash', phoneHmac(newPhone, serviceKey)).limit(1);
    if (dev && dev.length) return taken;
  }

  const { data: ident } = await db.from('zillion_identities').select('zillion_id').eq('phone_normalized', newPhone).maybeSingle();
  if (ident && ident.zillion_id !== ownZillionId) {
    const refs = [
      ['coop_members', 'zillion_id'], ['devices', 'zillion_id'], ['merchants', 'zillion_id'], ['agents', 'zillion_id'],
    ];
    for (const [t, c] of refs) {
      const { data } = await db.from(t).select(c).eq(c, ident.zillion_id).limit(1);
      if (data && data.length) return taken;
    }
    return { ok: true, staleZillionId: ident.zillion_id };
  }
  return { ok: true };
}

/** What approving would touch, for the admin to read before deciding. */
async function previewImpact(db, request, serviceKey) {
  const zid = request.zillion_id;
  const out = { societies: [], devices: 0, held_coins: 0, held_kobo: 0, warnings: [] };

  let members = [];
  if (zid) {
    const { data } = await db.from('coop_members').select('id, coop_id, name, status').eq('zillion_id', zid);
    members = data || [];
  }
  if (!members.find(m => m.id === request.member_id)) members.push({ id: request.member_id, coop_id: request.coop_id, name: request.member_name, status: 'ACTIVE' });
  const coopIds = [...new Set(members.map(m => m.coop_id))];
  const { data: socs } = await db.from('coop_societies').select('coop_id, name').in('coop_id', coopIds);
  const nameOf = Object.fromEntries((socs || []).map(s => [s.coop_id, s.name]));
  out.societies = members.map(m => ({ coop_id: m.coop_id, society: nameOf[m.coop_id] || m.coop_id, status: m.status }));

  if (serviceKey) {
    const oldHmac = phoneHmac(request.old_phone, serviceKey);
    const { data: devs } = await db.from('devices').select('device_hash, holder_hash').eq('phone_hash', oldHmac);
    out.devices = (devs || []).length;
    const holders = [createHash('sha256').update(request.old_phone).digest('hex'), ...(devs || []).map(d => d.holder_hash).filter(Boolean)];
    const { data: coins } = await db.from('coins').select('coin_id, amount').in('holder_hash', holders).eq('status', 'HELD');
    out.held_coins = (coins || []).length;
    out.held_kobo = (coins || []).reduce((s, c) => s + (c.amount || 0), 0);
    if (out.held_coins > 0) out.warnings.push(`This wallet holds ${out.held_coins} coin(s) worth ${(out.held_kobo / 100).toFixed(2)}. They are not moved. The member recovers them from the new number after signing in.`);
  }

  const { data: mer } = await db.from('merchants').select('merchant_id').eq('phone', request.old_phone).limit(1);
  if (mer && mer.length) out.warnings.push('This number is also a society admin login. That login is not changed by this request.');
  const { data: staff } = await db.from('coop_portal_users').select('id').eq('phone', request.old_phone).limit(1);
  if (staff && staff.length) out.warnings.push('This number is also a society staff login. That login is not changed by this request.');
  if (out.societies.length > 1) out.warnings.push(`This person belongs to ${out.societies.length} societies. The new number applies to all of them.`);
  return out;
}

/**
 * Moves the wallet identity to request.new_phone. Returns { ok:true, changes } or { ok:false, error }.
 * Every step records what it replaced so a failure restores the earlier steps, and so the audit trail can reverse it by hand.
 */
async function applyPhoneChange(db, request, serviceKey) {
  const newPhone = request.new_phone;
  const oldPhone = request.old_phone;
  if (!newPhone || !isValidPhone(newPhone)) return { ok: false, error: 'The request has no valid new number' };
  if (!serviceKey) return { ok: false, error: 'Server is missing SUPABASE_SERVICE_KEY' };

  const free = await checkNewNumberFree(db, newPhone, request.zillion_id, serviceKey);
  if (!free.ok) return { ok: false, error: free.reason };

  const undo = [];     // functions that restore, run in reverse on failure
  const changes = { identity: null, members: [], devices: [], removed_stale_identity: null };
  const rollback = async () => { for (const fn of undo.reverse()) { try { await fn(); } catch (e) { console.error('[memberPhoneChange] rollback step failed:', e.message); } } };

  try {
    if (free.staleZillionId) {
      const { data: stale } = await db.from('zillion_identities').select('*').eq('zillion_id', free.staleZillionId).maybeSingle();
      const { error } = await db.from('zillion_identities').delete().eq('zillion_id', free.staleZillionId);
      if (error) throw new Error('Could not clear the unused identity for the new number: ' + error.message);
      changes.removed_stale_identity = free.staleZillionId;
      if (stale) { const copy = { ...stale }; undo.push(async () => { await db.from('zillion_identities').insert(copy); }); }
    }

    let zid = request.zillion_id;
    const { data: ident } = zid
      ? await db.from('zillion_identities').select('zillion_id, phone_normalized').eq('zillion_id', zid).maybeSingle()
      : await db.from('zillion_identities').select('zillion_id, phone_normalized').eq('phone_normalized', oldPhone).maybeSingle();
    if (ident) {
      zid = ident.zillion_id;
      const before = ident.phone_normalized;
      const { error } = await db.from('zillion_identities').update({ phone_normalized: newPhone }).eq('zillion_id', zid);
      if (error) throw new Error('Could not update the identity: ' + error.message);
      changes.identity = { zillion_id: zid, from: before, to: newPhone };
      undo.push(async () => { await db.from('zillion_identities').update({ phone_normalized: before }).eq('zillion_id', zid); });
    }

    const { data: byZid } = zid ? await db.from('coop_members').select('id, coop_id, phone_normalized').eq('zillion_id', zid) : { data: [] };
    const rows = [...(byZid || [])];
    if (!rows.find(r => r.id === request.member_id)) {
      const { data: own } = await db.from('coop_members').select('id, coop_id, phone_normalized').eq('id', request.member_id).maybeSingle();
      if (own) rows.push(own);
    }
    for (const r of rows) {
      const before = r.phone_normalized;
      const { error } = await db.from('coop_members').update({ phone_normalized: newPhone }).eq('id', r.id);
      if (error) throw new Error('Could not update a society membership: ' + error.message);
      changes.members.push({ id: r.id, coop_id: r.coop_id, from: before, to: newPhone });
      undo.push(async () => { await db.from('coop_members').update({ phone_normalized: before }).eq('id', r.id); });
    }

    const oldHmac = phoneHmac(oldPhone, serviceKey);
    const newHmac = phoneHmac(newPhone, serviceKey);
    const { data: devs } = await db.from('devices').select('device_hash, phone_hash, phone_number').eq('phone_hash', oldHmac);
    for (const d of (devs || [])) {
      const beforeHash = d.phone_hash, beforeNumber = d.phone_number;
      const patch = { phone_hash: newHmac };
      if (beforeNumber) patch.phone_number = newPhone;
      const { error } = await db.from('devices').update(patch).eq('device_hash', d.device_hash);
      if (error) throw new Error('Could not update a wallet device: ' + error.message);
      changes.devices.push({ device_hash: d.device_hash, phone_hash_from: beforeHash, phone_number_from: beforeNumber || null });
      undo.push(async () => {
        const back = { phone_hash: beforeHash }; if (beforeNumber) back.phone_number = beforeNumber;
        await db.from('devices').update(back).eq('device_hash', d.device_hash);
      });
    }
    return { ok: true, changes };
  } catch (e) {
    await rollback();
    return { ok: false, error: e.message };
  }
}

/**
 * Checks a code sent by send-otp.js to this number. Same hashing, attempt cap and single use as verify-otp.js, but it issues no login.
 * Returns { ok:true } or { ok:false, error }.
 */
async function verifyPhoneOtp(db, phone, code, otpSecret) {
  if (!otpSecret) return { ok: false, error: 'Server is missing OTP_SECRET' };
  const c = String(code || '').trim();
  if (!/^\d{6}$/.test(c)) return { ok: false, error: 'Enter the 6 digit code sent to your email' };
  const { data: rows, error } = await db.from('otp_requests').select('id, hashed_otp, expires_at, attempts, used')
    .eq('phone', phone).eq('used', false).order('created_at', { ascending: false }).limit(1);
  if (error) return { ok: false, error: 'Could not check the code. Please try again.' };
  const rec = rows && rows[0];
  if (!rec) return { ok: false, error: 'No valid code found. Please request a new code.' };
  if (new Date(rec.expires_at) < new Date()) return { ok: false, error: 'The code has expired. Please request a new one.' };
  if (rec.attempts >= 5) return { ok: false, error: 'Too many attempts. Please request a new code.' };
  const { data: bumped } = await db.from('otp_requests').update({ attempts: rec.attempts + 1 }).eq('id', rec.id).eq('attempts', rec.attempts).select('id');
  if (!bumped || !bumped.length) return { ok: false, error: 'Too many simultaneous attempts. Wait a moment and try again.' };
  let match = false;
  try {
    const exp = Buffer.from(rec.hashed_otp, 'hex');
    const got = Buffer.from(createHmac('sha256', otpSecret).update(`${c}:${phone}`).digest('hex'), 'hex');
    match = exp.length === got.length && timingSafeEqual(exp, got);
  } catch { match = false; }
  if (!match) return { ok: false, error: 'Incorrect code. Check it and try again.' };
  await db.from('otp_requests').update({ used: true }).eq('id', rec.id);
  return { ok: true };
}

module.exports = {
  verifyPhoneOtp,
  normalisePhone, isValidPhone, last10, digits, maskPhone,
  LINK_DAYS, OPEN_STATUSES, newToken, hashToken, expiryFromNow, phoneHmac,
  checkNewNumberFree, previewImpact, applyPhoneChange,
};
