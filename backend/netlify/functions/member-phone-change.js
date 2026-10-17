/**
 * zillion/backend/netlify/functions/member-phone-change.js
 *
 * Public side of the member wallet number change feature. The member opens the one time link Zillion staff sent them.
 * There is no login. The link itself (a long random token, stored only as a hash) is the credential, and the new number is proven
 * with a text message code before anything is submitted.
 *
 * GET  ?t=<token>                          what the page should show (state, society, masked old number, staff note)
 * POST {t, action:'upload', file_base64, file_name, mime_type}
 * POST {t, action:'submit', new_phone, otp, reason}
 *
 * The text message code is requested from the existing /api/v1/send-otp. Nothing changes on the member's account here:
 * the request only goes to the staff queue. Staff approval is what moves the number (admin-member-phone-change.js).
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { cleanText }        = require('../../lib/cleanText');
const { limitByIp, limitByKey, tooManyRequests } = require('../../lib/publicRateLimit');
const M = require('../../lib/memberPhoneChange');

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 6;
const ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const EDITABLE = ['LINK_SENT', 'MORE_PROOF_REQUESTED'];

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');
  const db = getServiceClient();

  const ipLimit = await limitByIp(db, event, 'member-phone-change', { windowMinutes: 15, maxAttempts: 80, lockoutMinutes: 15 });
  if (!ipLimit.allowed) return tooManyRequests(ipLimit.retryAfterSeconds, 'requests');

  let body = {};
  if (event.httpMethod === 'POST') { try { body = JSON.parse(event.body || '{}'); } catch { return err(400, 'Invalid JSON'); } }
  const token = String(((event.queryStringParameters || {}).t) || body.t || '').trim();
  if (!token || token.length < 20 || token.length > 100) return err(404, 'This link is not valid.');
  const tokenHash = M.hashToken(token);

  const { data: r } = await db.from('coop_member_phone_change_requests').select('*').eq('token_hash', tokenHash).maybeSingle();
  if (!r) return err(404, 'This link is not valid.');

  const expired = EDITABLE.includes(r.status) && new Date(r.expires_at) < new Date();

  if (event.httpMethod === 'GET') {
    const { data: soc } = await db.from('coop_societies').select('name').eq('coop_id', r.coop_id).maybeSingle();
    return ok({
      state: expired ? 'EXPIRED' : r.status,
      society: soc && soc.name || '',
      member_name: r.member_name || '',
      old_phone_masked: M.maskPhone(r.old_phone),
      new_phone: r.new_phone || '',
      reason: r.reason || '',
      staff_note: (r.status === 'MORE_PROOF_REQUESTED' || r.status === 'REJECTED') ? (r.admin_note || '') : '',
      proof: (r.proof || []).map(p => ({ name: p.name, uploaded_at: p.uploaded_at })),
      new_proof_needed: r.status === 'MORE_PROOF_REQUESTED',
    });
  }

  const rl = await limitByKey(db, 'member-phone-change-token', tokenHash.slice(0, 24), { windowMinutes: 60, maxAttempts: 40, lockoutMinutes: 30 });
  if (!rl.allowed) return tooManyRequests(rl.retryAfterSeconds, 'attempts');

  if (expired) return err(410, 'This link has expired. Ask Zillion support for a new one.');
  if (!EDITABLE.includes(r.status)) return err(409, r.status === 'SUBMITTED' ? 'Your request is already with Zillion for review.' : 'This request is closed.');

  // ── Upload one proof file ─────────────────────────────────────────────────
  if (body.action === 'upload') {
    const fileName = cleanText(body.file_name, 120);
    const mime = String(body.mime_type || '').trim();
    if (!fileName) return err(400, 'file_name is required');
    if (!ALLOWED_MIME.includes(mime)) return err(400, 'The file must be a PDF, JPEG, PNG or WEBP');
    let buf; try { buf = Buffer.from(String(body.file_base64 || ''), 'base64'); } catch { return err(400, 'The file could not be read'); }
    if (!buf.length) return err(400, 'The file is empty');
    if (buf.length > MAX_BYTES) return err(400, 'The file is too large. The limit is 4MB.');
    const proof = Array.isArray(r.proof) ? r.proof : [];
    if (proof.length >= MAX_FILES) return err(400, `You can attach up to ${MAX_FILES} files`);

    const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
    const path = `${r.id}/${Date.now()}-${safe}`;
    const { error: upErr } = await db.storage.from('member-phone-change-proofs').upload(path, buf, { contentType: mime, upsert: false });
    if (upErr) return err(500, 'Could not save the file. Please try again.');
    const entry = { path, name: fileName, mime, uploaded_at: new Date().toISOString() };
    const { error: updErr } = await db.from('coop_member_phone_change_requests').update({ proof: [...proof, entry] }).eq('id', r.id).in('status', EDITABLE);
    if (updErr) return err(500, 'Could not attach the file. Please try again.');
    return ok({ success: true, files: proof.length + 1 });
  }

  // ── Submit ────────────────────────────────────────────────────────────────
  if (body.action === 'submit') {
    const reason = cleanText(body.reason, 500) || r.reason || '';
    if (reason.length < 5) return err(400, 'Please tell us why the number is changing');
    const newPhone = M.normalisePhone(body.new_phone || r.new_phone);
    if (!M.isValidPhone(newPhone)) return err(400, 'Enter a valid mobile number');
    if (M.last10(newPhone) === M.last10(r.old_phone)) return err(400, 'That is the number already on your account');

    const proof = Array.isArray(r.proof) ? r.proof : [];
    if (r.status === 'MORE_PROOF_REQUESTED' && !proof.some(p => new Date(p.uploaded_at) > new Date(r.updated_at))) {
      return err(400, 'Attach the extra proof Zillion asked for, then send again');
    }

    const free = await M.checkNewNumberFree(db, newPhone, r.zillion_id, process.env.SUPABASE_SERVICE_KEY);
    if (!free.ok) return err(409, free.reason);

    // A number that was already proven on an earlier round does not need a second code. A different number always does.
    const alreadyProven = r.otp_verified_at && r.new_phone === newPhone;
    if (!alreadyProven) {
      const v = await M.verifyPhoneOtp(db, newPhone, body.otp, process.env.OTP_SECRET);
      if (!v.ok) return err(400, v.error);
    }

    const now = new Date().toISOString();
    const { data: upd } = await db.from('coop_member_phone_change_requests')
      .update({ status: 'SUBMITTED', new_phone: newPhone, reason, otp_verified_at: alreadyProven ? r.otp_verified_at : now, submitted_at: now, updated_at: now })
      .eq('id', r.id).in('status', EDITABLE).select('id');
    if (!upd || !upd.length) return err(409, 'This request has changed. Reload the page.');
    return ok({ success: true, message: 'Sent. Zillion will review your request and contact you.' });
  }

  return err(400, 'Unknown action');
};
