/**
 * zillion/backend/lib/auditLog.js
 *
 * Shared admin audit logging. admin_audit_log already existed and was
 * being written to for login events, but resource_type/resource_id/
 * request_body sat unused, and most sensitive admin actions (float
 * top-ups, coin freezes, MFB approvals, commission changes) weren't
 * logged here at all — each only left a trace in its own table, with
 * no single place to answer "what has this admin done." This closes
 * that gap without changing the login-logging behavior that already
 * works. Fails silently — an audit-logging failure should never block
 * the actual admin action it's describing.
 */
'use strict';

/**
 * @param {object} db  Supabase client (service role)
 * @param {object} opts
 * @param {string} opts.action        e.g. 'FLOAT_TOPUP', 'COIN_FREEZE', 'MFB_REQUEST_APPROVED'
 * @param {string} [opts.username]    admin username or identity string
 * @param {string} [opts.role]        admin role at time of action
 * @param {string} [opts.ip]          caller IP
 * @param {string} [opts.resourceType]  e.g. 'agent', 'coin', 'mfb_request'
 * @param {string} [opts.resourceId]    the specific ID acted on
 * @param {object} [opts.requestBody]   the actual request payload (redact secrets before passing)
 * @param {'SUCCESS'|'FAILURE'|'PENDING'} [opts.result]
 * @param {string} [opts.error]
 */
async function auditLog(db, opts) {
  try {
    await db.from('admin_audit_log').insert({
      username:       opts.username || 'unknown',
      role:           opts.role || null,
      ip_address:     opts.ip || null,
      action:         opts.action,
      resource_type:  opts.resourceType || null,
      resource_id:    opts.resourceId || null,
      request_body:   opts.requestBody || null,
      result:         opts.result || 'SUCCESS',
      error_message:  opts.error || null,
    });
  } catch (e) {
    console.warn('[auditLog] failed (non-fatal):', e.message);
  }
}

module.exports = { auditLog };
