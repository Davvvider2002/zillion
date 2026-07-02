-- ============================================================
-- ZILLION RBAC — Admin User Management Schema
-- Run in Supabase SQL Editor AFTER the main schema.sql
-- ============================================================

-- ── ENUMS ─────────────────────────────────────────────────────────────────────

CREATE TYPE admin_role AS ENUM (
  'SUPER_ADMIN',   -- Full access, user management, all operations
  'COMPLIANCE',    -- Read all + freeze/suspend, view audit logs, no mutations
  'OPERATIONS',    -- Float management, agent ops, reconcile (no audit/user mgmt)
  'SUPPORT',       -- View customers/merchants/transactions, no mutations
  'AUDITOR',       -- Read-only + export, immutable log access (external auditors)
  'VIEWER'         -- Dashboard overview only, no PII
);

CREATE TYPE admin_status AS ENUM (
  'ACTIVE',           -- Normal access
  'PENDING_SETUP',    -- Created, awaiting first login & password change
  'LOCKED',           -- Too many failed attempts (auto or manual)
  'SUSPENDED',        -- Manually suspended by SUPER_ADMIN
  'DEACTIVATED'       -- Soft-deleted (retain audit trail)
);

-- ── ADMIN USERS ───────────────────────────────────────────────────────────────

CREATE TABLE admin_users (
  user_id             UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
  username            VARCHAR(50)     NOT NULL UNIQUE,
  email               VARCHAR(255)    NOT NULL UNIQUE,
  full_name           VARCHAR(128)    NOT NULL,
  role                admin_role      NOT NULL DEFAULT 'VIEWER',
  status              admin_status    NOT NULL DEFAULT 'PENDING_SETUP',

  -- Authentication
  password_hash       VARCHAR(256)    NOT NULL,  -- bcrypt, cost 12
  totp_secret         VARCHAR(64),               -- NULL if TOTP not set up yet
  totp_enabled        BOOLEAN         NOT NULL DEFAULT FALSE,
  totp_required       BOOLEAN         NOT NULL DEFAULT FALSE,  -- set TRUE for SUPER_ADMIN, COMPLIANCE

  -- Password policy
  must_change_password BOOLEAN        NOT NULL DEFAULT TRUE,  -- TRUE on creation
  password_changed_at  TIMESTAMPTZ,
  password_expires_at  TIMESTAMPTZ,  -- NULL = never expires (set 90 days for CBN compliance)

  -- Account lockout
  failed_attempts     INTEGER         NOT NULL DEFAULT 0,
  locked_until        TIMESTAMPTZ,               -- NULL or future timestamp
  last_failed_at      TIMESTAMPTZ,

  -- Activity
  last_login_at       TIMESTAMPTZ,
  last_login_ip       VARCHAR(64),
  last_activity_at    TIMESTAMPTZ,
  created_by          UUID            REFERENCES admin_users(user_id),
  created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  deactivated_at      TIMESTAMPTZ,
  deactivated_by      UUID            REFERENCES admin_users(user_id),

  -- Constraints
  CONSTRAINT username_format CHECK (username ~ '^[a-z][a-z0-9_]{2,49}$'),
  CONSTRAINT no_self_deactivation CHECK (user_id != deactivated_by)
);

CREATE INDEX idx_admin_users_username ON admin_users (username);
CREATE INDEX idx_admin_users_email    ON admin_users (email);
CREATE INDEX idx_admin_users_role     ON admin_users (role);
CREATE INDEX idx_admin_users_status   ON admin_users (status);

-- ── PASSWORD HISTORY (last 5 hashes — enforces no reuse) ─────────────────────

CREATE TABLE admin_password_history (
  id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID          NOT NULL REFERENCES admin_users(user_id) ON DELETE CASCADE,
  password_hash   VARCHAR(256)  NOT NULL,
  changed_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pwd_history_user ON admin_password_history (user_id, changed_at DESC);

-- ── ADMIN SESSIONS (extend existing) ──────────────────────────────────────────
-- Drop existing and recreate with user_id + session_id for proper tracking

DROP TABLE IF EXISTS admin_sessions CASCADE;

CREATE TABLE admin_sessions (
  id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id      VARCHAR(64)   NOT NULL UNIQUE,  -- random, sent to client
  token_hash      VARCHAR(64)   NOT NULL UNIQUE,  -- HMAC of session_id
  user_id         UUID          REFERENCES admin_users(user_id),
  username        VARCHAR(50),
  role            admin_role,
  ip_address      VARCHAR(64),
  user_agent      TEXT,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ   NOT NULL,
  last_used_at    TIMESTAMPTZ,
  used            BOOLEAN       NOT NULL DEFAULT FALSE,  -- one-time TOTP step token
  revoked         BOOLEAN       NOT NULL DEFAULT FALSE,
  revoke_reason   VARCHAR(64)
);

CREATE INDEX idx_sessions_token_hash  ON admin_sessions (token_hash);
CREATE INDEX idx_sessions_user_id     ON admin_sessions (user_id);
CREATE INDEX idx_sessions_expires     ON admin_sessions (expires_at);

-- ── ADMIN AUDIT LOG (immutable — no UPDATE/DELETE ever) ───────────────────────

CREATE TABLE admin_audit_log (
  log_id          UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- Who
  user_id         UUID          REFERENCES admin_users(user_id),
  username        VARCHAR(50)   NOT NULL,
  role            admin_role,
  ip_address      VARCHAR(64),
  user_agent      TEXT,
  session_id      VARCHAR(64),
  -- What
  action          VARCHAR(64)   NOT NULL,  -- e.g. 'FLOAT_TOPUP', 'COIN_FREEZE', 'USER_CREATE'
  resource_type   VARCHAR(32),             -- 'coin', 'agent', 'merchant', 'admin_user', etc.
  resource_id     VARCHAR(128),            -- ID of affected resource
  -- Detail
  request_body    JSONB,                   -- sanitised (no passwords)
  response_code   INTEGER,
  result          VARCHAR(16),             -- 'SUCCESS', 'FAILURE', 'DENIED'
  error_message   TEXT,
  -- Immutability
  logged_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  checksum        VARCHAR(64)   NOT NULL DEFAULT ''  -- SHA256 of log fields (tamper detection)
);

CREATE INDEX idx_audit_user       ON admin_audit_log (user_id, logged_at DESC);
CREATE INDEX idx_audit_action     ON admin_audit_log (action, logged_at DESC);
CREATE INDEX idx_audit_resource   ON admin_audit_log (resource_type, resource_id);
CREATE INDEX idx_audit_logged_at  ON admin_audit_log (logged_at DESC);

-- Prevent UPDATE/DELETE on audit log (immutable record)
CREATE RULE no_update_audit AS ON UPDATE TO admin_audit_log DO INSTEAD NOTHING;
CREATE RULE no_delete_audit AS ON DELETE TO admin_audit_log DO INSTEAD NOTHING;

-- ── PERMISSIONS VIEW (computed from role) ──────────────────────────────────────
-- Used by backend middleware to check permissions without extra lookups

CREATE VIEW admin_permissions AS
SELECT
  u.user_id,
  u.username,
  u.role,
  u.status,
  -- Coin operations
  (u.role = 'SUPER_ADMIN')                                             AS can_mint,
  (u.role IN ('SUPER_ADMIN','OPERATIONS'))                             AS can_float_topup,
  (u.role IN ('SUPER_ADMIN','OPERATIONS'))                             AS can_force_reconcile,
  (u.role IN ('SUPER_ADMIN','COMPLIANCE'))                             AS can_freeze_coin,
  (u.role IN ('SUPER_ADMIN','COMPLIANCE'))                             AS can_suspend_entity,
  -- Data access
  (u.role IN ('SUPER_ADMIN','COMPLIANCE','OPERATIONS','SUPPORT','AUDITOR')) AS can_view_transactions,
  (u.role IN ('SUPER_ADMIN','COMPLIANCE','OPERATIONS','SUPPORT'))          AS can_view_pii,
  (u.role != 'VIEWER')                                                 AS can_view_dashboard,
  -- Export
  (u.role IN ('SUPER_ADMIN','COMPLIANCE','OPERATIONS','AUDITOR'))      AS can_export,
  -- Audit
  (u.role IN ('SUPER_ADMIN','COMPLIANCE','AUDITOR'))                   AS can_view_audit_log,
  -- User management (SUPER_ADMIN only)
  (u.role = 'SUPER_ADMIN')                                             AS can_manage_users,
  (u.role = 'SUPER_ADMIN')                                             AS can_reset_passwords,
  (u.role = 'SUPER_ADMIN')                                             AS can_change_config
FROM admin_users u
WHERE u.status = 'ACTIVE';

-- ── SEED DATA: Default Admin Users ───────────────────────────────────────────
-- Passwords are bcrypt hashes of the TEMPORARY initial passwords.
-- ALL users must change password on first login (must_change_password = TRUE).
--
-- DEFAULT CREDENTIALS (change immediately after setup):
--   david.ayomidotun  / Zillion@2026!Admin  (SUPER_ADMIN)
--   farruk.manzoor    / Zillion@2026!CTO    (SUPER_ADMIN)
--   operations.mgr    / Zillion@2026!Ops1   (OPERATIONS)
--   compliance.off    / Zillion@2026!Comp1  (COMPLIANCE)
--   support.desk      / Zillion@2026!Sup1   (SUPPORT)
--   ext.auditor       / Zillion@2026!Aud1   (AUDITOR)
--
-- GENERATE FRESH HASHES:
--   node -e "const b=require('bcryptjs');console.log(b.hashSync('Zillion@2026!Admin',12))"
--
-- The hashes below are PLACEHOLDERS — replace with real bcrypt hashes before seeding.
--
-- ⚠️  NEVER store plain-text passwords anywhere. This file must NOT be
--     committed to a public repo with real password hashes.

DO $$
DECLARE
  super_id UUID := uuid_generate_v4();
  cto_id   UUID := uuid_generate_v4();
BEGIN

INSERT INTO admin_users (
  user_id, username, email, full_name, role, status,
  password_hash, totp_required, must_change_password
) VALUES
  (super_id, 'david.ayomidotun', 'david@bakkiego.com',
   'David Ayomidotun', 'SUPER_ADMIN', 'PENDING_SETUP',
   '$REPLACE_WITH_BCRYPT_HASH_david$', TRUE, TRUE),

  (cto_id,   'farruk.manzoor',  'farruk@bakkiego.com',
   'Farruk Manzoor', 'SUPER_ADMIN', 'PENDING_SETUP',
   '$REPLACE_WITH_BCRYPT_HASH_farruk$', TRUE, TRUE),

  (uuid_generate_v4(), 'operations.mgr', 'ops@zillion.ng',
   'Operations Manager', 'OPERATIONS', 'PENDING_SETUP',
   '$REPLACE_WITH_BCRYPT_HASH_ops$', FALSE, TRUE),

  (uuid_generate_v4(), 'compliance.off', 'compliance@zillion.ng',
   'Compliance Officer', 'COMPLIANCE', 'PENDING_SETUP',
   '$REPLACE_WITH_BCRYPT_HASH_compliance$', TRUE, TRUE),

  (uuid_generate_v4(), 'support.desk', 'support@zillion.ng',
   'Support Desk', 'SUPPORT', 'PENDING_SETUP',
   '$REPLACE_WITH_BCRYPT_HASH_support$', FALSE, TRUE),

  (uuid_generate_v4(), 'ext.auditor', 'auditor@external.com',
   'External Auditor', 'AUDITOR', 'PENDING_SETUP',
   '$REPLACE_WITH_BCRYPT_HASH_auditor$', FALSE, TRUE);

-- Record initial passwords in history (prevents re-use even of temp password)
-- (hash recorded when user first sets their real password via the change-password flow)

END $$;

-- ── RLS ────────────────────────────────────────────────────────────────────────
ALTER TABLE admin_users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_sessions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_audit_log      ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_password_history ENABLE ROW LEVEL SECURITY;
-- Service role bypasses RLS — all access via Netlify functions only

-- ── AUTO-UPDATE updated_at ──────────────────────────────────────────────────────
CREATE TRIGGER admin_users_updated_at
  BEFORE UPDATE ON admin_users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- POST-SETUP CHECKLIST:
-- 1. Replace all $REPLACE_WITH_BCRYPT_HASH_xxx$ placeholders
--    with real bcrypt(12) hashes before running
-- 2. Set ADMIN_TOTP_REQUIRED=true in Netlify env
-- 3. Each SUPER_ADMIN and COMPLIANCE user must scan TOTP QR
--    on first login before gaining access
-- 4. Verify audit log immutability: attempt DELETE FROM admin_audit_log
--    and confirm it silently does nothing
-- ============================================================
