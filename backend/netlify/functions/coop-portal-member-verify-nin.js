/**
 * zillion/backend/netlify/functions/coop-portal-member-verify-nin.js
 *
 * POST /api/v1/coop-portal-member-verify-nin
 *
 * Coop-level NIN verification for a member — separate system from the wallet-tier kyc-verify-nin.js. Every
 * attempt is billed to the society (matched or not — Dojah charges per call either way), so this refuses up
 * front if the society has an unpaid usage invoice from a previous month, before ever calling Dojah.
 *
 * PREFILLED FROM THE WALLET: nin in the body is now OPTIONAL. If the member has already submitted their NIN
 * from their own wallet profile (coop-member-submit-nin.js), this decrypts that stored value in memory for
 * this one call — the admin never sees or types the number. Manual entry still works (nin in the body), for a
 * member who hasn't submitted one yet. On a confirmed MATCH, the stored encrypted NIN is cleared — only the
 * hash remains from then on. On a mismatch it is deliberately left in place so a retry doesn't need the member
 * to resubmit.
 *
 * EXEMPTION: a trial or never_expires society gets a "Test Mode" no-op instead — see
 * coopKycBilling.isKycActiveForSociety(). Nothing is checked with Dojah, billed, or written to the member's
 * kyc_status until the society is on an active, paying subscription.
 *
 * Body: { member_id, nin? }
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');
const { auditLog }         = require('../../lib/auditLog');
const { hashNIN, decryptNIN, lookupNIN, mustEnv } = require('../../lib/coopDojahNin');
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
  const typedNin = body.nin !== undefined ? String(body.nin).trim() : null;
  if (!memberId) return err(400, 'member_id is required');
  if (typedNin !== null && !/^\d{11}$/.test(typedNin)) return err(400, 'NIN must be exactly 11 digits');

  const { data: member } = await db.from('coop_members').select('id, name, coop_id, kyc_status, nin_encrypted').eq('id', memberId).eq('coop_id', coopId).maybeSingle();
  if (!member) return err(404, 'Member not found in this society');

  // Trial / never-expiring societies never trigger a real Dojah call or a real charge — nothing here is
  // confirmed until the society is on an active, paying subscription.
  const { data: societyFlags } = await db.from('coop_societies').select('never_expires').eq('coop_id', coopId).maybeSingle();
  if (!billing.isKycActiveForSociety({ subscription_status: resolved.society.subscription_status, never_expires: societyFlags?.never_expires })) {
    return ok({
      success: true, test_mode: true, matched: null, kyc_status: member.kyc_status, charged_kobo: 0,
      message: 'Test Mode: NIN/KYC verification is not active for a trial or never-expiring society — nothing has been checked, confirmed, or billed. This activates once the society is on a paid subscription.',
    });
  }

  let nin = typedNin;
  if (!nin && member.nin_encrypted) {
    try { nin = decryptNIN(member.nin_encrypted); }
    catch (e) { console.error('[coop-portal-member-verify-nin] could not decrypt stored NIN:', e.message); return err(500, 'Could not read the NIN this member submitted — ask them to resubmit, or enter it manually.'); }
  }
  if (!nin) return err(400, 'No NIN on file for this member yet — ask them to submit it from their wallet, or enter it manually.');

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
    // Verified: only the hash needs to persist from here — the encrypted raw number is cleared.
    await db.from('coop_members').update({ kyc_status: 'VERIFIED', nin_hash: ninHash, nin_verified_at: new Date().toISOString(), nin_encrypted: null }).eq('id', memberId);
  }

  await auditLog(db, {
    action: 'COOP_MEMBER_NIN_VERIFY_ATTEMPT', role: auth.payload.role, username: resolved.society.merchant_id,
    resourceType: 'coop_member', resourceId: memberId,
    requestBody: { matched: result.matched, charged_kobo: chargedKobo, source: typedNin ? 'manual_entry' : 'wallet_submission' },
  });

  return ok({
    success: true, matched: result.matched, kyc_status: result.matched ? 'VERIFIED' : member.kyc_status,
    charged_kobo: chargedKobo,
    message: result.matched ? 'NIN verified — this matches the name on record.' : "This NIN's registered name does not match the member's name on record.",
  });
};
