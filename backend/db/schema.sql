-- ============================================================
-- ZILLION RBAC — Admin User Management Schema
-- Run in Supabase SQL Editor AFTER the main schema.sql
-- ============================================================

-- ── ENUMS (idempotent — safe to re-run) ──────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE admin_role AS ENUM (
    'SUPER_ADMIN',
    'COMPLIANCE',
    'OPERATIONS',
    'SUPPORT',
    'AUDITOR',
    'VIEWER'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE admin_status AS ENUM (
    'ACTIVE',
    'PENDING_SETUP',
    'LOCKED',
    'SUSPENDED',
    'DEACTIVATED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── ADMIN USERS ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS admin_users (
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
  CONSTRAINT username_format CHECK (username ~ '^[a-z][a-z0-9_.]{2,49}$'),
  CONSTRAINT no_self_deactivation CHECK (user_id != deactivated_by)
);

CREATE INDEX IF NOT EXISTS idx_admin_users_username ON admin_users (username);
CREATE INDEX IF NOT EXISTS idx_admin_users_email    ON admin_users (email);
CREATE INDEX IF NOT EXISTS idx_admin_users_role     ON admin_users (role);
CREATE INDEX IF NOT EXISTS idx_admin_users_status   ON admin_users (status);

-- ── PASSWORD HISTORY (last 5 hashes — enforces no reuse) ─────────────────────

CREATE TABLE IF NOT EXISTS admin_password_history (
  id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID          NOT NULL REFERENCES admin_users(user_id) ON DELETE CASCADE,
  password_hash   VARCHAR(256)  NOT NULL,
  changed_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pwd_history_user ON admin_password_history (user_id, changed_at DESC);

-- ── ADMIN SESSIONS (extend existing) ──────────────────────────────────────────
-- Drop existing and recreate with user_id + session_id for proper tracking

DROP TABLE IF EXISTS admin_sessions CASCADE;

CREATE TABLE IF NOT EXISTS admin_sessions (
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

CREATE INDEX IF NOT EXISTS idx_sessions_token_hash  ON admin_sessions (token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id     ON admin_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires     ON admin_sessions (expires_at);

-- ── ADMIN AUDIT LOG (immutable — no UPDATE/DELETE ever) ───────────────────────

CREATE TABLE IF NOT EXISTS admin_audit_log (
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

CREATE INDEX IF NOT EXISTS idx_audit_user       ON admin_audit_log (user_id, logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action     ON admin_audit_log (action, logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_resource   ON admin_audit_log (resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_logged_at  ON admin_audit_log (logged_at DESC);

-- Prevent UPDATE/DELETE on audit log (immutable record)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_rules WHERE rulename='no_update_audit' AND tablename='admin_audit_log'
  ) THEN
    EXECUTE 'CREATE RULE no_update_audit AS ON UPDATE TO admin_audit_log DO INSTEAD NOTHING';
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_rules WHERE rulename='no_delete_audit' AND tablename='admin_audit_log'
  ) THEN
    EXECUTE 'CREATE RULE no_delete_audit AS ON DELETE TO admin_audit_log DO INSTEAD NOTHING';
  END IF;
END $$;

-- ── PERMISSIONS VIEW (computed from role) ──────────────────────────────────────
-- Used by backend middleware to check permissions without extra lookups

CREATE OR REPLACE VIEW admin_permissions AS
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
-- GENERATE FRESH HASHES (uses Node built-in crypto.scrypt — no npm install needed):
--   node -e "
--     const c=require('crypto'),s=c.randomBytes(32).toString('hex');
--     c.scrypt('Zillion@2026!Admin',s,64,{N:65536,r:8,p:1},(e,h)=>
--       console.log('scrypt$65536$8$1$'+s+'$'+h.toString('hex')));
--   "
--
-- The hashes below are PLACEHOLDERS — replace with real scrypt hashes before seeding.
-- Hash format: scrypt$N$r$p$salt_hex$hash_hex
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
   'scrypt$16384$8$1$49b45129409c26434a0865865e63d07932b188d0327a15899a144d0422e10f15$f0d6e1a5259fd2cedde33c8f9217a3038d7de4c0e359a3ac61ea34aafe5f01e1811e8b703309cefaea5a3d219174103fac00b27c05e8a8cfc8c0f93a42e90564', TRUE, TRUE),

  (cto_id,   'farruk.manzoor',  'farruk@bakkiego.com',
   'Farruk Manzoor', 'SUPER_ADMIN', 'PENDING_SETUP',
   'scrypt$16384$8$1$1b4069035ad02bef908a7d7ecc25567b244184a37cafe2153e56a1fc622c5c51$6aef1acae9beefacd0000fdd63cf11eaba0703e5d585546ba225661d7c8afbd1091b7e89a4ee7c9177f114c8512012ecf750ad2cd6d0cff11807e70d6a55bb00', TRUE, TRUE),

  (uuid_generate_v4(), 'operations.mgr', 'ops@zillion.ng',
   'Operations Manager', 'OPERATIONS', 'PENDING_SETUP',
   'scrypt$16384$8$1$2db36b211108d9c103f18d2289284a84ea8feb8ee8fd062c2afeca4f121d45d7$52cc3987f7a10805e3db26a8857b9e7c3f3bae0b12f78e4a70b9f42e57a9faab0465df75c0657d2570339a095452c1b6b46e57e7d771e3cf069d0f326fee3370', FALSE, TRUE),

  (uuid_generate_v4(), 'compliance.off', 'compliance@zillion.ng',
   'Compliance Officer', 'COMPLIANCE', 'PENDING_SETUP',
   'scrypt$16384$8$1$3bfeedeaf3dce80033efab81bf76e9edfad513d5e12a80dee38e2555d1c2dc18$98484ce39e8a7b1bdd5d36d480d4e391feddadeb13ae34babbe2e8734480ab94f505bafa1415bfb55a637db6c234fc91ebcf6a79db75f739286b20e92f289637', TRUE, TRUE),

  (uuid_generate_v4(), 'support.desk', 'support@zillion.ng',
   'Support Desk', 'SUPPORT', 'PENDING_SETUP',
   'scrypt$16384$8$1$fa0d50f804d51403c06adbcc58aec3e180a7ab325f3e8fd809418a35850153bb$d5cbd1418550b02afef5491a3c7680cc03ccd5fe379d7a11f461c53053ddd4c8beead091421a06dc3281098b2e5be029741b59120c0ded7a559486ef67dd0523', FALSE, TRUE),

  (uuid_generate_v4(), 'ext.auditor', 'auditor@external.com',
   'External Auditor', 'AUDITOR', 'PENDING_SETUP',
   'scrypt$16384$8$1$0672f3b9c3c54502c4871e1652018933658851de1af81727ecd55809207ecdda$241d32ec78b646bc1e6d6c847470337c92543bc8f1b25de09a98dd16c97cadcb3136a4fa6b400d775fc871fcfef5d540279588da3cd0c251a127a0ce83f24bd1', FALSE, TRUE)
ON CONFLICT (username) DO NOTHING;

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
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname='admin_users_updated_at'
  ) THEN
    CREATE TRIGGER admin_users_updated_at
      BEFORE UPDATE ON admin_users
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END $$;

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
