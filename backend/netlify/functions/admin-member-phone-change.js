/**
 * zillion/backend/netlify/functions/admin-member-phone-change.js
 *
 * Staff side of the member wallet number change feature (Zillion Coop admin, not the society admin).
 *
 * GET  ?action=members&q=&coop_id=     find a member to send a link to (name, number or member number)
 * GET  ?action=list&status=&coop_id=   the request queue
 * GET  ?action=detail&id=              one request, with proof links and what approving would touch
 * POST {action:'create_link', member_id, note?}
 * POST {action:'reissue_link', id}     a fresh link for a request still open (the old link stops working)
 * POST {action:'decide', id, decision:'approve'|'reject'|'more_proof', note?}
 * POST {action:'cancel', id}
 *
 * Reading: SUPER_ADMIN, OPERATIONS, COMPLIANCE, SUPPORT, AUDITOR. Writing: SUPER_ADMIN or OPERATIONS.
 * Every change is audit logged. See lib/memberPhoneChange.js for exactly what approval moves.
 */
'use strict';

const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { auditLog }               = require('../../lib/auditLog');
const { cleanText }              = require('../../lib/cleanText');
const { limitByKey, tooManyRequests } = require('../../lib/publicRateLimit');
const M = require('../../lib/memberPhoneChange');

const READ_ROLES  = ['SUPER_ADMIN', 'OPERATIONS', 'COMPLIANCE', 'SUPPORT', 'AUDITOR'];
const WRITE_ROLES = ['SUPER_ADMIN', 'OPERATIONS'];
const LIST_COLS = 'id, coop_id, member_id, member_name, old_phone, new_phone, reason, status, expires_at, submitted_at, decided_by, decided_at, admin_note, link_note, created_by, created_at, otp_verified_at, proof';

function siteBase() { return (process.env.PUBLIC_SITE_URL || process.env.URL || 'https://zillion.ng').replace(/\/+$/, ''); }
function linkFor(token) { return `${siteBase()}/member-number-change/?t=${encodeURIComponent(token)}`; }

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, READ_ROLES)) return err(403, 'Admin access required');
  const canWrite = requireRole(auth, WRITE_ROLES);

  const db = getServiceClient();
  const who = auth.payload.username || auth.payload.sub || 'staff';
  const ip = event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || null;
  const log = (action, id, body, result = 'SUCCESS') => auditLog(db, { action, username: who, role: auth.payload.role, ip, resourceType: 'member_phone_change', resourceId: id, requestBody: body, result });

  // ── Reads ─────────────────────────────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    const action = q.action || 'list';

    if (action === 'members') {
      const term = cleanText(q.q, 60);
      if (!term || term.length < 2) return err(400, 'Type at least 2 characters to search');
      let query = db.from('coop_members').select('id, coop_id, name, phone_normalized, member_number, status').limit(25);
      if (q.coop_id) query = query.eq('coop_id', cleanText(q.coop_id, 60));
      const digitsOnly = M.digits(term);
      const safe = term.replace(/[%,()]/g, ' ').trim();
      query = digitsOnly.length >= 4 && /^[+\d\s()-]+$/.test(term)
        ? query.ilike('phone_normalized', `%${digitsOnly.slice(-10)}%`)
        : query.or(`name.ilike.%${safe}%,member_number.ilike.%${safe}%`);
      const { data: rows, error } = await query;
      if (error) return err(500, 'Search failed');
      const coopIds = [...new Set((rows || []).map(r => r.coop_id))];
      const { data: socs } = coopIds.length ? await db.from('coop_societies').select('coop_id, name').in('coop_id', coopIds) : { data: [] };
      const nameOf = Object.fromEntries((socs || []).map(s => [s.coop_id, s.name]));
      const ids = (rows || []).map(r => r.id);
      const { data: open } = ids.length ? await db.from('coop_member_phone_change_requests').select('member_id, status').in('member_id', ids).in('status', M.OPEN_STATUSES) : { data: [] };
      const openBy = Object.fromEntries((open || []).map(o => [o.member_id, o.status]));
      return ok({ members: (rows || []).map(r => ({ ...r, society: nameOf[r.coop_id] || r.coop_id, open_request: openBy[r.id] || null })) });
    }

    if (action === 'list') {
      let query = db.from('coop_member_phone_change_requests').select(LIST_COLS).order('created_at', { ascending: false }).limit(200);
      if (q.status) query = query.eq('status', cleanText(q.status, 30));
      if (q.coop_id) query = query.eq('coop_id', cleanText(q.coop_id, 60));
      const { data, error } = await query;
      if (error) return err(500, 'Could not load requests');
      const coopIds = [...new Set((data || []).map(r => r.coop_id))];
      const { data: socs } = coopIds.length ? await db.from('coop_societies').select('coop_id, name').in('coop_id', coopIds) : { data: [] };
      const nameOf = Object.fromEntries((socs || []).map(s => [s.coop_id, s.name]));
      return ok({ requests: (data || []).map(r => ({ ...r, society: nameOf[r.coop_id] || r.coop_id, proof_count: (r.proof || []).length })) });
    }

    if (action === 'detail') {
      const { data: r } = await db.from('coop_member_phone_change_requests').select('*').eq('id', cleanText(q.id, 60)).maybeSingle();
      if (!r) return err(404, 'Request not found');
      const proof = [];
      for (const p of (r.proof || [])) {
        let url = null;
        try { const { data: s } = await db.storage.from('member-phone-change-proofs').createSignedUrl(p.path, 600); url = s && s.signedUrl || null; } catch { /* link just stays empty */ }
        proof.push({ name: p.name, mime: p.mime, uploaded_at: p.uploaded_at, url });
      }
      const impact = await previewImpact(db, r);
      const { token_hash, applied_changes, ...safe } = r;
      return ok({ request: { ...safe, proof }, impact, applied: r.status === 'APPROVED' ? applied_changes : undefined });
    }
    return err(400, 'Unknown action');
  }

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');
  if (!canWrite) return err(403, 'SUPER_ADMIN or OPERATIONS role required');

  let body; try { body = JSON.parse(event.body || '{}'); } catch { return err(400, 'Invalid JSON'); }
  const action = body.action;

  const rl = await limitByKey(db, 'admin-member-phone-change', who, { windowMinutes: 60, maxAttempts: 120, lockoutMinutes: 15 });
  if (!rl.allowed) return tooManyRequests(rl.retryAfterSeconds, 'requests');

  // ── Create a link ─────────────────────────────────────────────────────────
  if (action === 'create_link') {
    const memberId = cleanText(body.member_id, 60);
    if (!memberId) return err(400, 'member_id is required');
    const { data: member } = await db.from('coop_members').select('id, coop_id, zillion_id, phone_normalized, name, status').eq('id', memberId).maybeSingle();
    if (!member) return err(404, 'Member not found');
    const { data: open } = await db.from('coop_member_phone_change_requests').select('id, status').eq('member_id', memberId).in('status', M.OPEN_STATUSES).limit(1);
    if (open && open.length) return err(409, `This member already has an open request (${open[0].status.replace(/_/g, ' ').toLowerCase()}). Reissue its link or cancel it first.`);

    const token = M.newToken();
    const row = {
      coop_id: member.coop_id, member_id: member.id, member_name: member.name || null, zillion_id: member.zillion_id || null,
      old_phone: member.phone_normalized, status: 'LINK_SENT', token_hash: M.hashToken(token), expires_at: M.expiryFromNow(),
      link_note: cleanText(body.note, 300) || null, created_by: who,
    };
    const { data: created, error } = await db.from('coop_member_phone_change_requests').insert(row).select('id').single();
    if (error) {
      if (/duplicate|unique/i.test(error.message)) return err(409, 'This member already has an open request');
      return err(500, 'Could not create the link: ' + error.message);
    }
    await log('MEMBER_PHONE_CHANGE_LINK_CREATED', created.id, { member_id: memberId, coop_id: member.coop_id, old_phone: member.phone_normalized });
    return ok({ success: true, id: created.id, link: linkFor(token), expires_at: row.expires_at, message: 'Link created. Send it to the member. It works once and expires in 7 days.' });
  }

  // ── Fresh link for an open request ────────────────────────────────────────
  if (action === 'reissue_link') {
    const id = cleanText(body.id, 60);
    const { data: r } = await db.from('coop_member_phone_change_requests').select('id, status').eq('id', id).maybeSingle();
    if (!r) return err(404, 'Request not found');
    if (!M.OPEN_STATUSES.includes(r.status)) return err(409, 'Only an open request can get a new link');
    const token = M.newToken();
    const expires = M.expiryFromNow();
    const { data: upd } = await db.from('coop_member_phone_change_requests')
      .update({ token_hash: M.hashToken(token), expires_at: expires, updated_at: new Date().toISOString() })
      .eq('id', id).in('status', M.OPEN_STATUSES).select('id');
    if (!upd || !upd.length) return err(409, 'The request changed. Reload and try again.');
    await log('MEMBER_PHONE_CHANGE_LINK_REISSUED', id, {});
    return ok({ success: true, link: linkFor(token), expires_at: expires });
  }

  // ── Cancel ────────────────────────────────────────────────────────────────
  if (action === 'cancel') {
    const id = cleanText(body.id, 60);
    const { data: upd } = await db.from('coop_member_phone_change_requests')
      .update({ status: 'CANCELLED', decided_by: who, decided_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', id).in('status', M.OPEN_STATUSES).select('id');
    if (!upd || !upd.length) return err(409, 'Only an open request can be cancelled');
    await log('MEMBER_PHONE_CHANGE_CANCELLED', id, {});
    return ok({ success: true });
  }

  // ── Decide ────────────────────────────────────────────────────────────────
  if (action === 'decide') {
    const id = cleanText(body.id, 60);
    const decision = body.decision;
    const note = cleanText(body.note, 500);
    if (!['approve', 'reject', 'more_proof'].includes(decision)) return err(400, 'decision must be approve, reject or more_proof');
    if (decision !== 'approve' && (!note || note.length < 5)) return err(400, decision === 'reject' ? 'Give the member a reason for the rejection' : 'Say what proof the member should add');

    const { data: r } = await db.from('coop_member_phone_change_requests').select('*').eq('id', id).maybeSingle();
    if (!r) return err(404, 'Request not found');
    if (r.status !== 'SUBMITTED') return err(409, 'Only a submitted request can be decided');
    const now = new Date().toISOString();

    if (decision === 'reject') {
      const { data: upd } = await db.from('coop_member_phone_change_requests')
        .update({ status: 'REJECTED', admin_note: note, decided_by: who, decided_at: now, updated_at: now }).eq('id', id).eq('status', 'SUBMITTED').select('id');
      if (!upd || !upd.length) return err(409, 'The request changed. Reload and try again.');
      await log('MEMBER_PHONE_CHANGE_REJECTED', id, { note });
      return ok({ success: true, status: 'REJECTED' });
    }

    if (decision === 'more_proof') {
      const { data: upd } = await db.from('coop_member_phone_change_requests')
        .update({ status: 'MORE_PROOF_REQUESTED', admin_note: note, expires_at: M.expiryFromNow(), updated_at: now }).eq('id', id).eq('status', 'SUBMITTED').select('id');
      if (!upd || !upd.length) return err(409, 'The request changed. Reload and try again.');
      await log('MEMBER_PHONE_CHANGE_MORE_PROOF', id, { note });
      return ok({ success: true, status: 'MORE_PROOF_REQUESTED', message: 'The member can reopen the same link to add proof. Its expiry is extended by 7 days.' });
    }

    // approve
    if (!r.otp_verified_at || !r.new_phone) return err(409, 'The member has not verified the new number');
    // Claim the request first so two staff clicking approve at once cannot apply it twice.
    const { data: claimed } = await db.from('coop_member_phone_change_requests')
      .update({ status: 'APPROVED', decided_by: who, decided_at: now, admin_note: note || null, updated_at: now }).eq('id', id).eq('status', 'SUBMITTED').select('id');
    if (!claimed || !claimed.length) return err(409, 'The request changed. Reload and try again.');

    const result = await M.applyPhoneChange(db, r, process.env.SUPABASE_SERVICE_KEY);
    if (!result.ok) {
      await db.from('coop_member_phone_change_requests')
        .update({ status: 'SUBMITTED', decided_by: null, decided_at: null, updated_at: new Date().toISOString() }).eq('id', id);
      await log('MEMBER_PHONE_CHANGE_APPROVED', id, { old_phone: r.old_phone, new_phone: r.new_phone, error: result.error }, 'FAILURE');
      return err(409, result.error);
    }
    await db.from('coop_member_phone_change_requests').update({ applied_changes: result.changes }).eq('id', id);
    await log('MEMBER_PHONE_CHANGE_APPROVED', id, { old_phone: r.old_phone, new_phone: r.new_phone, coop_id: r.coop_id, memberships: result.changes.members.length, devices: result.changes.devices.length });
    return ok({ success: true, status: 'APPROVED', message: `Number changed to ${r.new_phone} on ${result.changes.members.length} society membership(s). The member signs in with the new number.` });
  }

  return err(400, 'Unknown action');
};

// Needed by the detail view; defined after the handler so the module reads top to bottom.
const previewImpact = (db, r) => M.previewImpact(db, r, process.env.SUPABASE_SERVICE_KEY);
