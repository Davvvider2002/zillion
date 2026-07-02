/**
 * lib/rbac.js — Role-Based Access Control middleware for Zillion Admin
 *
 * Usage in any Netlify function:
 *   const { requirePermission, auditAction, PERMS } = require('../lib/rbac');
 *
 *   exports.handler = async (event) => {
 *     const { auth, err } = requirePermission(event, PERMS.FLOAT_TOPUP);
 *     if (err) return err;
 *     // ... auth.userId, auth.username, auth.role available
 *     await auditAction(db, auth, event, 'FLOAT_TOPUP', 'agent', agentId, 'SUCCESS');
 *   };
 */
'use strict';

const { createHmac } = require('crypto');

// ── JWT verification ──────────────────────────────────────────────────────────
function verifyAdminJWT(authHeader) {
  const secret = process.env.JWT_SECRET || '';
  if (!authHeader || !authHeader.startsWith('Bearer '))
    return { valid:false, reason:'Missing Bearer token' };

  const token  = authHeader.slice(7);
  const parts  = token.split('.');
  if (parts.length !== 3) return { valid:false, reason:'Malformed token' };

  try {
    const sig = createHmac('sha256', secret)
      .update(`${parts[0]}.${parts[1]}`).digest('base64url');
    if (sig !== parts[2]) return { valid:false, reason:'Invalid signature' };

    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const now     = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) return { valid:false, reason:'Token expired' };

    return { valid:true, payload };
  } catch(e) {
    return { valid:false, reason:'Token parse error: ' + e.message };
  }
}

// ── Permission constants ───────────────────────────────────────────────────────
const PERMS = {
  // Coin operations
  MINT:             'can_mint',
  FLOAT_TOPUP:      'can_float_topup',
  FORCE_RECONCILE:  'can_force_reconcile',
  FREEZE_COIN:      'can_freeze_coin',
  SUSPEND_ENTITY:   'can_suspend_entity',
  // Data access
  VIEW_TRANSACTIONS:'can_view_transactions',
  VIEW_PII:         'can_view_pii',
  VIEW_DASHBOARD:   'can_view_dashboard',
  EXPORT:           'can_export',
  VIEW_AUDIT_LOG:   'can_view_audit_log',
  // User management
  MANAGE_USERS:     'can_manage_users',
  RESET_PASSWORDS:  'can_reset_passwords',
  CHANGE_CONFIG:    'can_change_config',
  // Any admin (just needs a valid admin JWT)
  ANY_ADMIN:        'any_admin',
};

// ── Role → permission map ──────────────────────────────────────────────────────
const ROLE_PERMISSIONS = {
  SUPER_ADMIN: new Set(Object.values(PERMS)),

  COMPLIANCE: new Set([
    PERMS.FREEZE_COIN, PERMS.SUSPEND_ENTITY,
    PERMS.VIEW_TRANSACTIONS, PERMS.VIEW_PII,
    PERMS.VIEW_DASHBOARD, PERMS.EXPORT, PERMS.VIEW_AUDIT_LOG,
    PERMS.ANY_ADMIN,
  ]),

  OPERATIONS: new Set([
    PERMS.FLOAT_TOPUP, PERMS.FORCE_RECONCILE,
    PERMS.VIEW_TRANSACTIONS, PERMS.VIEW_PII,
    PERMS.VIEW_DASHBOARD, PERMS.EXPORT,
    PERMS.ANY_ADMIN,
  ]),

  SUPPORT: new Set([
    PERMS.VIEW_TRANSACTIONS, PERMS.VIEW_PII,
    PERMS.VIEW_DASHBOARD,
    PERMS.ANY_ADMIN,
  ]),

  AUDITOR: new Set([
    PERMS.VIEW_TRANSACTIONS, PERMS.VIEW_DASHBOARD,
    PERMS.EXPORT, PERMS.VIEW_AUDIT_LOG,
    PERMS.ANY_ADMIN,
  ]),

  VIEWER: new Set([
    PERMS.VIEW_DASHBOARD,
    PERMS.ANY_ADMIN,
  ]),
};

// ── hasPermission ─────────────────────────────────────────────────────────────
function hasPermission(role, permission) {
  if (permission === PERMS.ANY_ADMIN) {
    return !!ROLE_PERMISSIONS[role];
  }
  const perms = ROLE_PERMISSIONS[role];
  return perms ? perms.has(permission) : false;
}

// ── requirePermission — returns either { auth } or { err (response object) } ──
function requirePermission(event, permission) {
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const { valid, payload, reason } = verifyAdminJWT(authHeader);

  if (!valid) {
    return {
      err: {
        statusCode: 401,
        headers:    { 'Content-Type': 'application/json' },
        body:       JSON.stringify({ error: 'Authentication required: ' + reason }),
      }
    };
  }

  const role = payload.role || '';
  if (!hasPermission(role, permission)) {
    return {
      err: {
        statusCode: 403,
        headers:    { 'Content-Type': 'application/json' },
        body:       JSON.stringify({
          error:      `Permission denied. Required: ${permission}. Your role: ${role}.`,
          your_role:  role,
          permission_needed: permission,
        }),
      }
    };
  }

  return {
    auth: {
      userId:   payload.sub,
      username: payload.username || 'unknown',
      role:     payload.role,
      sessionId:payload.session_id,
      payload,
    }
  };
}

// ── auditAction — write to admin_audit_log ────────────────────────────────────
async function auditAction(db, auth, event, action, resourceType, resourceId, result, extra) {
  const ip  = event.headers?.['x-forwarded-for'] || 'unknown';
  const ua  = event.headers?.['user-agent'] || '';
  let body  = null;

  try {
    body = event.body ? JSON.parse(event.body) : null;
    if (body) {
      delete body.password; delete body.new_password;
      delete body.admin_secret; delete body.totp_secret;
    }
  } catch { /* ignore */ }

  await db.from('admin_audit_log').insert({
    user_id:       auth?.userId   || null,
    username:      auth?.username || 'system',
    role:          auth?.role     || null,
    ip_address:    ip,
    user_agent:    ua,
    session_id:    auth?.sessionId || null,
    action,
    resource_type: resourceType || null,
    resource_id:   resourceId ? String(resourceId) : null,
    request_body:  body,
    result:        result || 'UNKNOWN',
    ...extra,
  }).catch(e => console.error('[rbac.auditAction]', e.message));
}

// ── Version header injection ─────────────────────────────────────────────────
// All admin responses include X-Zillion-Version header for traceability
const PLATFORM_VERSION = process.env.PLATFORM_VERSION || '1.0.0';
function versionHeaders() {
  return {
    'Content-Type':    'application/json',
    'X-Zillion-Version': PLATFORM_VERSION,
    'X-Zillion-Build': process.env.BUILD_ID || 'local',
  };
}

module.exports = { requirePermission, hasPermission, auditAction, PERMS, versionHeaders };
