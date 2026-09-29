/**
 * zillion/backend/netlify/functions/coop-member-profile.js
 *
 * GET /api/v1/coop-member-profile
 *
 * A member's own KYC profile view for the wallet app: their editable identity fields, their NIN submission
 * state, and a single clear status the wallet can show as a badge. Phone is shown but never editable here —
 * it's the identity key the rest of the system resolves logins from (same rule as coop-portal-update-member.js).
 *
 * Auth: wallet JWT (the member's own token).
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { resolveMemberForZillionId } = require('../../lib/coopMemberResolve');
const { isKycActiveForSociety } = require('../../lib/coopKycBilling');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  const zillionId = auth.payload.zillion_id;
  if (!zillionId) return ok({ is_coop_member: false });

  const db = getServiceClient();
  const member = await resolveMemberForZillionId(db, zillionId,
    'id, coop_id, name, phone_normalized, email, address, occupation, date_of_birth, kyc_status, nin_verified_at, nin_submitted_at, nin_encrypted',
    auth.payload.coop_id || null);
  if (!member) return ok({ is_coop_member: false });

  // One clear status word for the wallet UI, so it never has to reconstruct this logic itself.
  const kycState = member.kyc_status === 'VERIFIED' ? 'VERIFIED' : (member.nin_encrypted ? 'PENDING_REVIEW' : 'UNVERIFIED');

  const { data: society } = await db.from('coop_societies').select('subscription_status, never_expires').eq('coop_id', member.coop_id).maybeSingle();
  const kycActive = isKycActiveForSociety(society || {});

  return ok({
    is_coop_member: true,
    profile: {
      name: member.name, phone_normalized: member.phone_normalized, email: member.email,
      address: member.address, occupation: member.occupation, date_of_birth: member.date_of_birth,
    },
    kyc: {
      status: kycState, // VERIFIED | PENDING_REVIEW | UNVERIFIED
      nin_verified_at: member.nin_verified_at, nin_submitted_at: member.nin_submitted_at,
      active: kycActive, // false on a trial or never_expires society — submitting still works, but nothing gets checked or billed until this is true
    },
  });
};
