/**
 * zillion/backend/netlify/functions/coop-portal-member-verify-nin.js
 *
 * POST /api/v1/coop-portal-member-verify-nin
 *
 * Coop-level NIN verification for a member — separate system from the wallet-tier kyc-verify-nin.js. Every
 * attempt is billed to the society (matched or not — Dojah charges per call either way), so this refuses up
 * front if the society has an unpaid usage invoice from a previous month, before ever calling Dojah.
 *
 * Body: { member_id, nin }
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');
const { auditLog }         = require('../../lib/auditLog');
const { hashNIN, lookupNIN, mustEnv } = require('../../lib/coopDojahNin');
const billing = require('../../lib/coopKycBilling');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');

  const db = getServiceClient();
  const resolved = await resolvePortalSociety(db, auth);
  if (!resolved.ok) return err(resolved.status, resolved.error);
  const coopId = resolved.society.coop_id;

  if (!(await requirePortalPermission(db, auth, 'members', 'edit'))) {
    return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return err(400, 'Invalid JSON'); }
  const memberId = body.member_id;
  const nin = String(body.nin || '').trim();
  if (!memberId) return err(400, 'member_id is required');
  if (!/^\d{11}$/.test(nin)) return err(400, 'NIN must be exactly 11 digits');

  const { data: member } = await db.from('coop_members').select('id, name, coop_id, kyc_status').eq('id', memberId).eq('coop_id', coopId).maybeSingle();
  if (!member) return err(404, 'Member not found in this society');

  try {
    await billing.assertNotBlocked(db, coopId);
  } catch (e) {
    if (e instanceof billing.KycBillingError) return err(402, e.message);
    throw e;
  }

  let salt;
  try { salt = mustEnv('COOP_NIN_HASH_SALT'); } catch (e) { console.error('[coop-portal-member-verify-nin]', e.message); return err(500, 'Server misconfigured — contact support'); }
  const ninHash = hashNIN(nin, salt);

  let result;
  try {
    result = await lookupNIN(nin, { memberName: member.name });
  } catch (e) {
    // Dojah bills per call whether it succeeds or errors, so this attempt is still recorded and charged.
    try {
      await billing.recordVerificationAttempt(db, {
        coopId, memberId, ninHash, matched: false, dojahReference: e.reference || null,
        dojahCostKobo: e.costKobo || 0, createdBy: `${auth.payload.role}:${resolved.society.merchant_id}`,
      });
    } catch (e2) { console.error('[coop-portal-member-verify-nin] failed to record errored attempt:', e2.message); }
    console.error('[coop-portal-member-verify-nin] Dojah lookup failed:', e.message);
    return err(502, 'NIN lookup could not be completed. This attempt has still been billed — please try again or contact support.');
  }

  const { chargedKobo } = await billing.recordVerificationAttempt(db, {
    coopId, memberId, ninHash, matched: result.matched, dojahReference: result.reference,
    dojahCostKobo: result.costKobo, createdBy: `${auth.payload.role}:${resolved.society.merchant_id}`,
  });

  if (result.matched) {
    await db.from('coop_members').update({ kyc_status: 'VERIFIED', nin_hash: ninHash, nin_verified_at: new Date().toISOString() }).eq('id', memberId);
  }

  await auditLog(db, {
    action: 'COOP_MEMBER_NIN_VERIFY_ATTEMPT', role: auth.payload.role, username: resolved.society.merchant_id,
    resourceType: 'coop_member', resourceId: memberId,
    requestBody: { matched: result.matched, charged_kobo: chargedKobo },
  });

  return ok({
    success: true, matched: result.matched, kyc_status: result.matched ? 'VERIFIED' : member.kyc_status,
    charged_kobo: chargedKobo,
    message: result.matched ? 'NIN verified — this matches the name on record.' : "This NIN's registered name does not match the member's name on record.",
  });
};
