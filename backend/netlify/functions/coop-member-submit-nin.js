/**
 * zillion/backend/netlify/functions/coop-member-submit-nin.js
 *
 * POST /api/v1/coop-member-submit-nin
 *
 * A member submits their own NIN (and date of birth, and optionally confirms/edits their name and address)
 * from their wallet profile. The NIN is encrypted at rest (AES-256-GCM, server key only — see
 * coopDojahNin.encryptNIN) so a coop admin can verify it later WITHOUT the member being asked for it again —
 * coop-portal-member-verify-nin.js decrypts it in memory for that one call and clears it the moment a match
 * is confirmed. Submitting again before that happens simply replaces the previous encrypted value.
 *
 * This never calls Dojah and never charges the society — submitting is free; verifying (admin-triggered) is
 * the billed action.
 *
 * Body: { nin, date_of_birth, name?, address? }   (date_of_birth: YYYY-MM-DD)
 * Auth: wallet JWT (the member's own token).
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { resolveMemberForZillionId } = require('../../lib/coopMemberResolve');
const { encryptNIN } = require('../../lib/coopDojahNin');

function isReasonableDob(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const d = new Date(iso + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return false;
  const ageYears = (Date.now() - d.getTime()) / (365.25 * 86400000);
  return ageYears >= 16 && ageYears <= 120;
}

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  const zillionId = auth.payload.zillion_id;
  if (!zillionId) return err(403, 'Not a cooperative member');

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return err(400, 'Invalid JSON'); }

  const nin = String(body.nin || '').trim();
  const dob = String(body.date_of_birth || '').trim();
  if (!/^\d{11}$/.test(nin)) return err(400, 'NIN must be exactly 11 digits');
  if (!isReasonableDob(dob)) return err(400, 'date_of_birth must be a valid date (YYYY-MM-DD) for someone between 16 and 120 years old');

  const db = getServiceClient();
  const member = await resolveMemberForZillionId(db, zillionId, 'id, coop_id', auth.payload.coop_id || null);
  if (!member) return err(403, 'Not a cooperative member');

  const updates = { date_of_birth: dob, nin_submitted_at: new Date().toISOString() };
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return err(400, 'name cannot be empty');
    updates.name = name;
  }
  if (body.address !== undefined) updates.address = String(body.address).trim() || null;

  try {
    updates.nin_encrypted = encryptNIN(nin);
  } catch (e) {
    console.error('[coop-member-submit-nin]', e.message);
    return err(500, 'Server misconfigured — contact support');
  }

  const { error } = await db.from('coop_members').update(updates).eq('id', member.id).eq('coop_id', member.coop_id);
  if (error) return err(500, 'Could not save your details — please try again');

  return ok({ success: true, kyc_status: 'PENDING_REVIEW', message: 'Submitted. Your society admin will verify this — you\'ll see your status update once they do.' });
};
