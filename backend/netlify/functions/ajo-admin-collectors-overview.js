/**
 * zillion/backend/netlify/functions/ajo-admin-collectors-overview.js
 *
 * GET /api/v1/ajo-admin-collectors-overview
 *
 * The admin-side read view the escrow system never had: every
 * collector profile regardless of status (pending, active, rejected,
 * delisted - ajo-collector-directory.js deliberately only shows
 * ACTIVE non-delisted ones, since that's the contributor-facing
 * view, not the admin one), plus every escrow disbursement still
 * awaiting confirmation. One call powers all three cards on the Ajo
 * Collectors admin page rather than three round trips.
 *
 * Auth: internal admin JWT, SUPER_ADMIN / COMPLIANCE / OPERATIONS only.
 */
'use strict';

const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');

const ADMIN_ROLES = ['SUPER_ADMIN', 'COMPLIANCE', 'OPERATIONS'];

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ADMIN_ROLES)) return err(403, 'Admin access required');

  const db = getServiceClient();

  const { data: profiles } = await db.from('ajo_collector_profiles')
    .select('id, zillion_id, escrow_status, escrow_account_number, escrow_account_name, compliance_score, delisted_at, delisted_reason, created_at')
    .order('created_at', { ascending: false });

  const { data: pendingDisbursements } = await db.from('ajo_collector_escrow_disbursements')
    .select('id, collector_profile_id, scheme_id, reference, intended_amount_kobo, intended_reason, status, initiated_by, created_at')
    .eq('status', 'PENDING').order('created_at', { ascending: false });

  const zillionIds = (profiles || []).map(p => p.zillion_id);
  const { data: identities } = zillionIds.length
    ? await db.from('zillion_identities').select('zillion_id, phone_normalized').in('zillion_id', zillionIds)
    : { data: [] };
  const phoneByZillionId = new Map((identities || []).map(i => [i.zillion_id, i.phone_normalized]));

  const collectors = (profiles || []).map(p => ({ ...p, phone_normalized: phoneByZillionId.get(p.zillion_id) || null }));

  const profileById = new Map(collectors.map(c => [c.id, c]));
  const disbursements = (pendingDisbursements || []).map(d => ({
    ...d, collector_phone: profileById.get(d.collector_profile_id)?.phone_normalized || null,
  }));

  return ok({
    pending_verifications: collectors.filter(c => c.escrow_status === 'PENDING_VERIFICATION'),
    collectors,
    pending_disbursements: disbursements,
  });
};
