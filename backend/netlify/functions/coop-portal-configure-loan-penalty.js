/**
 * zillion/backend/netlify/functions/coop-portal-configure-loan-penalty.js
 *
 * POST /api/v1/coop-portal-configure-loan-penalty
 *
 * Society-admin self-service configuration for the loan-specific late
 * repayment penalty. Three real states, not two:
 *   - loan_late_fee_type = null   → inherit the rate already configured
 *                                    for dues (late_fee_type/late_fee_value).
 *                                    This is the default.
 *   - loan_late_fee_type = 'none' → explicit opt-out. No loan penalty
 *                                    at all, even if dues has one set.
 *   - loan_late_fee_type = 'flat' | 'percentage' → a separate rate
 *                                    dedicated to loans, ignoring dues
 *                                    entirely. loan_late_fee_value is
 *                                    required in this case.
 *
 * The actual penalty is applied at most once per loan by
 * scheduled-reconcile.js, reading these fields via
 * computeLoanRepaymentStatus() — this endpoint only ever changes the
 * configured rate, never charges anything itself.
 *
 * coop_id is always the caller's own resolved society.
 *
 * Body: { loan_late_fee_type: null | 'none' | 'flat' | 'percentage', loan_late_fee_value?: integer }
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');
const { auditLog }             = require('../../lib/auditLog');

const VALID_TYPES = ['none', 'flat', 'percentage'];

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

  if (!(await requirePortalPermission(db, auth, 'loans'))) {
    return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  // null is a genuinely valid, meaningful value here (inherit from
  // dues) — only reject something present but not one of the three
  // recognized strings.
  const type = body.loan_late_fee_type === null || body.loan_late_fee_type === undefined ? null : body.loan_late_fee_type;
  if (type !== null && !VALID_TYPES.includes(type)) {
    return err(400, `loan_late_fee_type must be null, or one of: ${VALID_TYPES.join(', ')}`);
  }

  let value = null;
  if (type === 'flat' || type === 'percentage') {
    if (!Number.isInteger(body.loan_late_fee_value) || body.loan_late_fee_value <= 0) {
      return err(400, 'loan_late_fee_value must be a positive integer when loan_late_fee_type is flat or percentage');
    }
    value = body.loan_late_fee_value;
  }
  // type === 'none' or type === null both correctly leave value as null

  const { data: updated, error: updateErr } = await db.from('coop_societies')
    .update({ loan_late_fee_type: type, loan_late_fee_value: value })
    .eq('coop_id', coopId)
    .select().single();

  if (updateErr) return err(500, `Failed to configure loan penalty: ${updateErr.message}`);

  await auditLog(db, {
    action:       'COOP_PORTAL_LOAN_PENALTY_CONFIGURED',
    username:     auth.payload.merchant_id,
    role:         'merchant',
    ip:           event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_society',
    resourceId:   coopId,
    requestBody:  body,
    result:       'SUCCESS',
  });

  return ok({ success: true, society: updated });
};
