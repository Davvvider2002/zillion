-- ============================================================
-- ZILLION — Full schema for staging environment
-- Reconstructed from live production introspection (most tables
-- predate any committed migration file). Run in Supabase SQL Editor
-- on the staging project. Idempotent where practical.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Custom types ─────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE admin_role AS ENUM ('SUPER_ADMIN','COMPLIANCE','OPERATIONS','SUPPORT','AUDITOR','VIEWER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE admin_status AS ENUM ('ACTIVE','PENDING_SETUP','LOCKED','SUSPENDED','DEACTIVATED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE coin_status AS ENUM ('ISSUED','HELD','SPENT','REDEEMED','EXPIRED','FROZEN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE tx_status AS ENUM ('SETTLED','CONFLICT','PENDING','REVERSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Core tables (dependency order) ──────────────────────────

CREATE TABLE IF NOT EXISTS admin_users (
  user_id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  username              varchar(50) NOT NULL UNIQUE,
  email                 varchar(255) NOT NULL UNIQUE,
  full_name             varchar(128) NOT NULL,
  role                  admin_role NOT NULL DEFAULT 'VIEWER',
  status                admin_status NOT NULL DEFAULT 'PENDING_SETUP',
  password_hash         varchar(256) NOT NULL,
  totp_secret           varchar(64),
  totp_enabled          boolean NOT NULL DEFAULT false,
  totp_required         boolean NOT NULL DEFAULT false,
  must_change_password  boolean NOT NULL DEFAULT true,
  password_changed_at   timestamptz,
  password_expires_at   timestamptz,
  failed_attempts       integer NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  last_failed_at        timestamptz,
  last_login_at         timestamptz,
  last_login_ip         varchar(64),
  last_activity_at      timestamptz,
  created_by            uuid REFERENCES admin_users(user_id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deactivated_at        timestamptz,
  deactivated_by        uuid REFERENCES admin_users(user_id)
);

CREATE TABLE IF NOT EXISTS admin_password_history (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id        uuid NOT NULL REFERENCES admin_users(user_id),
  password_hash  varchar(256) NOT NULL,
  changed_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id      varchar(64) NOT NULL UNIQUE,
  token_hash      varchar(64) NOT NULL UNIQUE,
  user_id         uuid REFERENCES admin_users(user_id),
  username        varchar(50),
  role            admin_role,
  ip_address      varchar(64),
  user_agent      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  last_used_at    timestamptz,
  used            boolean NOT NULL DEFAULT false,
  revoked         boolean NOT NULL DEFAULT false,
  revoke_reason   varchar(64)
);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  log_id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         uuid REFERENCES admin_users(user_id),
  username        varchar(50) NOT NULL,
  role            admin_role,
  ip_address      varchar(64),
  user_agent      text,
  session_id      varchar(64),
  action          varchar(64) NOT NULL,
  resource_type   varchar(32),
  resource_id     varchar(128),
  request_body    jsonb,
  response_code   integer,
  result          varchar(16),
  error_message   text,
  logged_at       timestamptz NOT NULL DEFAULT now(),
  checksum        varchar(64) NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS agents (
  agent_id                 varchar(32) PRIMARY KEY,
  name                     varchar(128) NOT NULL,
  phone                    varchar(20) NOT NULL UNIQUE,
  location_name            varchar(128),
  float_balance_kobo       bigint NOT NULL DEFAULT 0,
  status                   varchar(16) NOT NULL DEFAULT 'ACTIVE',
  onboarded_at             timestamptz NOT NULL DEFAULT now(),
  last_activity            timestamptz,
  password_hash            text,
  mfb_id                   text,
  mfb_name                 text,
  commission_balance_kobo  bigint DEFAULT 0
);

CREATE TABLE IF NOT EXISTS merchants (
  merchant_id           text PRIMARY KEY,
  phone                 text NOT NULL,
  owner_name            text NOT NULL,
  business_name         text NOT NULL,
  business_type         text DEFAULT 'General',
  location              text,
  device_id             text,
  status                text DEFAULT 'ACTIVE',
  registered_at         timestamptz DEFAULT now(),
  last_login            timestamptz,
  zil_balance_kobo       integer DEFAULT 0,
  total_received_kobo   integer DEFAULT 0,
  notes                 text,
  password_hash         text,
  total_payments        integer DEFAULT 0,
  preferred_mfb_id      text,
  preferred_mfb_updated_at timestamptz
);

CREATE TABLE IF NOT EXISTS devices (
  device_hash        varchar(64) PRIMARY KEY,
  phone_hash         varchar(64) NOT NULL,
  public_key_hex     varchar(256) NOT NULL,
  registered_at      timestamptz NOT NULL DEFAULT now(),
  last_sync          timestamptz,
  fraud_score        integer NOT NULL DEFAULT 0,
  status             varchar(16) NOT NULL DEFAULT 'ACTIVE',
  kyc_tier           integer DEFAULT 1,
  nin_hash           text,
  bvn_hash           text,
  daily_limit_kobo   bigint DEFAULT 5000000,
  key_algorithm      text DEFAULT 'ECDSA_P256',
  holder_hash        text,
  preferred_mfb_id   text,
  preferred_mfb_updated_at timestamptz
);

CREATE TABLE IF NOT EXISTS coins (
  coin_id              varchar(64) PRIMARY KEY,
  amount               bigint NOT NULL,
  currency             char(3) NOT NULL DEFAULT 'NGN',
  issued_at            timestamptz NOT NULL,
  expires_at           timestamptz NOT NULL,
  issuer_id            varchar(32) NOT NULL,
  status               coin_status NOT NULL DEFAULT 'ISSUED',
  holder_hash          varchar(64),
  mint_sig             varchar(256) NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  grace_period_ends_at timestamptz,
  mfb_id               text
);

CREATE TABLE IF NOT EXISTS transactions (
  tx_id           varchar(80) PRIMARY KEY,
  coin_id         varchar(64) NOT NULL REFERENCES coins(coin_id),
  from_hash       varchar(64) NOT NULL,
  to_hash         varchar(64) NOT NULL,
  amount          bigint NOT NULL,
  tx_ts           timestamptz NOT NULL,
  sync_ts         timestamptz NOT NULL DEFAULT now(),
  env_sig         varchar(256) NOT NULL,
  nonce           varchar(64),
  status          tx_status NOT NULL DEFAULT 'SETTLED',
  conflict_ref    varchar(80),
  created_at      timestamptz NOT NULL DEFAULT now(),
  tx_type         text DEFAULT 'P2P',
  mfb_id          text,
  agent_id        text
);

CREATE TABLE IF NOT EXISTS otp_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone        text NOT NULL,
  hashed_otp   text NOT NULL,
  expires_at   timestamptz NOT NULL,
  attempts     integer DEFAULT 0,
  used         boolean DEFAULT false,
  created_at   timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fraud_events (
  event_id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  device_hash       varchar(64) NOT NULL,
  event_type        varchar(32) NOT NULL,
  coin_id           varchar(64),
  detected_at       timestamptz NOT NULL DEFAULT now(),
  resolved          boolean NOT NULL DEFAULT false,
  resolution_note   text,
  resolved_at       timestamptz
);

CREATE TABLE IF NOT EXISTS float_topups (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id           varchar(32) NOT NULL,
  amount_kobo        bigint NOT NULL,
  denomination_kobo  bigint NOT NULL,
  coin_count         integer NOT NULL,
  first_coin_id      varchar(64),
  last_coin_id       varchar(64),
  deposit_ref        text,
  approved_by        text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mfb_partners (
  mfb_id                text PRIMARY KEY,
  mfb_name              text NOT NULL,
  contact_name          text,
  contact_email         text,
  contact_phone         text,
  licence_number        text,
  state                 text DEFAULT 'Kano',
  tier                  text DEFAULT 'MFB',
  status                text DEFAULT 'ACTIVE',
  notes                 text DEFAULT '',
  created_at            timestamptz DEFAULT now(),
  portal_password_hash  text,
  portal_first_login    boolean DEFAULT true,
  last_login            timestamptz,
  updated_at            timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS commission_configs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  txn_type           text NOT NULL,
  scope              text NOT NULL DEFAULT 'global',
  scope_id           text,
  fee_pct            numeric(8,6) NOT NULL,
  fee_floor_kobo     integer NOT NULL DEFAULT 1000,
  fee_cap_kobo       integer NOT NULL DEFAULT 20000,
  mfb_share_pct      numeric(6,4) NOT NULL DEFAULT 0.2000,
  zillion_share_pct  numeric(6,4) NOT NULL DEFAULT 0.3000,
  note               text DEFAULT '',
  active             boolean NOT NULL DEFAULT true,
  effective_from     timestamptz NOT NULL DEFAULT now(),
  created_by         text,
  deactivated_by     text,
  deactivated_at     timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS commission_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coin_id           text,
  txn_type          text NOT NULL,
  txn_amount_kobo   integer NOT NULL,
  fee_kobo          integer NOT NULL DEFAULT 0,
  mfb_kobo          integer NOT NULL DEFAULT 0,
  zillion_kobo      integer NOT NULL DEFAULT 0,
  agent_kobo        integer NOT NULL DEFAULT 0,
  agent_id          text,
  mfb_id            text,
  merchant_id       text,
  status            text NOT NULL DEFAULT 'PENDING',
  settled_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_commission_balance (
  agent_id         text PRIMARY KEY,
  pending_kobo     integer NOT NULL DEFAULT 0,
  lifetime_kobo    integer NOT NULL DEFAULT 0,
  last_payout_at   timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bank_feed_queue (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key     text NOT NULL UNIQUE,
  event_type          text NOT NULL,
  zillion_tx_id       text,
  bank_ref_sender     text,
  bank_ref_receiver   text,
  amount_kobo         bigint NOT NULL,
  offline_ts          timestamptz,
  settled_ts          timestamptz,
  coin_ids            text[],
  agent_id            text,
  source              text DEFAULT 'ZILLION_OFFLINE',
  fraud_score         double precision DEFAULT 0.0,
  delivered           boolean DEFAULT false,
  delivered_at        timestamptz,
  retry_count         integer DEFAULT 0,
  created_at          timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS claim_bundles (
  claim_id       text PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  bundle_data    jsonb NOT NULL,
  agent_id       text NOT NULL,
  amount_kobo    integer NOT NULL,
  coin_count     integer NOT NULL,
  created_at     timestamptz DEFAULT now(),
  expires_at     timestamptz DEFAULT (now() + interval '16:00:00'),
  claimed_at     timestamptz,
  claimed_by     text,
  status         text DEFAULT 'PENDING',
  tx_pin_hash    text,
  pin_attempts   integer DEFAULT 0,
  pin_locked_at  timestamptz,
  pin_required   boolean DEFAULT false
);

CREATE TABLE IF NOT EXISTS coin_ledger (
  entry_id          bigserial PRIMARY KEY,
  coin_id           text NOT NULL,
  amount            bigint,
  event_type        text NOT NULL,
  prev_holder_hash  text,
  new_holder_hash   text,
  prev_status       text,
  new_status        text,
  changed_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_mfb_change_requests (
  request_id          text PRIMARY KEY DEFAULT ('MFBREQ-' || substr(md5(random()::text), 1, 12)),
  agent_id            text NOT NULL,
  current_mfb_id      text,
  current_mfb_name    text,
  requested_mfb_id    text NOT NULL,
  requested_mfb_name  text NOT NULL,
  status              text NOT NULL DEFAULT 'PENDING',
  reason              text,
  requested_at        timestamptz NOT NULL DEFAULT now(),
  reviewed_at         timestamptz,
  reviewed_by         text,
  review_notes        text
);

CREATE TABLE IF NOT EXISTS rate_limit_attempts (
  rate_key       text PRIMARY KEY,
  attempt_count  integer NOT NULL DEFAULT 0,
  window_start   timestamptz NOT NULL DEFAULT now(),
  locked_until   timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS system_alerts (
  alert_id      bigserial PRIMARY KEY,
  severity      text NOT NULL DEFAULT 'INFO',
  source        text NOT NULL,
  message       text NOT NULL,
  context       jsonb,
  resolved      boolean NOT NULL DEFAULT false,
  resolved_at   timestamptz,
  resolved_by   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ── Indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_audit_resource ON admin_audit_log (resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_user ON admin_audit_log (user_id, logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON admin_audit_log (action, logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logged_at ON admin_audit_log (logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_pwd_history_user ON admin_password_history (user_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON admin_sessions (expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON admin_sessions (token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON admin_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_admin_users_username ON admin_users (username);
CREATE INDEX IF NOT EXISTS idx_admin_users_status ON admin_users (status);
CREATE INDEX IF NOT EXISTS idx_admin_users_role ON admin_users (role);
CREATE INDEX IF NOT EXISTS idx_admin_users_email ON admin_users (email);
CREATE INDEX IF NOT EXISTS idx_agent_mfb_requests_agent ON agent_mfb_change_requests (agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_mfb_requests_status ON agent_mfb_change_requests (status);
CREATE INDEX IF NOT EXISTS idx_agents_mfb ON agents (mfb_id);
CREATE INDEX IF NOT EXISTS idx_feed_delivered ON bank_feed_queue (delivered);
CREATE INDEX IF NOT EXISTS idx_claim_status ON claim_bundles (status);
CREATE INDEX IF NOT EXISTS idx_claim_expires ON claim_bundles (expires_at);
CREATE INDEX IF NOT EXISTS idx_claim_agent ON claim_bundles (agent_id);
CREATE INDEX IF NOT EXISTS idx_coin_ledger_new_holder ON coin_ledger (new_holder_hash);
CREATE INDEX IF NOT EXISTS idx_coin_ledger_coin_id ON coin_ledger (coin_id);
CREATE INDEX IF NOT EXISTS idx_coin_ledger_prev_holder ON coin_ledger (prev_holder_hash);
CREATE INDEX IF NOT EXISTS idx_coin_ledger_changed_at ON coin_ledger (changed_at);
CREATE INDEX IF NOT EXISTS idx_coins_holder ON coins (holder_hash);
CREATE INDEX IF NOT EXISTS idx_coins_status ON coins (status);
CREATE INDEX IF NOT EXISTS idx_coins_expires ON coins (expires_at);
CREATE INDEX IF NOT EXISTS idx_coins_status_holder ON coins (status, holder_hash);
CREATE INDEX IF NOT EXISTS idx_coins_issuer ON coins (issuer_id);
CREATE INDEX IF NOT EXISTS idx_coins_mfb ON coins (mfb_id);
CREATE INDEX IF NOT EXISTS idx_comm_cfg_type_scope ON commission_configs (txn_type, scope, active);
CREATE INDEX IF NOT EXISTS idx_comm_cfg_scope_id ON commission_configs (scope_id, active);
CREATE INDEX IF NOT EXISTS idx_comm_mfb ON commission_events (mfb_id);
CREATE INDEX IF NOT EXISTS idx_comm_evt_agent ON commission_events (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comm_evt_type ON commission_events (txn_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comm_evt_mfb ON commission_events (mfb_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_devices_phone ON devices (phone_hash);
CREATE INDEX IF NOT EXISTS idx_devices_holder_hash ON devices (holder_hash);
CREATE INDEX IF NOT EXISTS idx_fraud_device ON fraud_events (device_hash);
CREATE INDEX IF NOT EXISTS idx_fraud_type ON fraud_events (event_type);
CREATE INDEX IF NOT EXISTS idx_fraud_resolved ON fraud_events (resolved);
CREATE INDEX IF NOT EXISTS idx_merchants_status ON merchants (status);
CREATE INDEX IF NOT EXISTS idx_merchants_phone ON merchants (phone);
CREATE INDEX IF NOT EXISTS idx_otp_expires ON otp_requests (expires_at);
CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_requests (phone);
CREATE INDEX IF NOT EXISTS idx_rate_limit_locked ON rate_limit_attempts (locked_until);
CREATE INDEX IF NOT EXISTS idx_system_alerts_unresolved ON system_alerts (resolved, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_alerts_severity ON system_alerts (severity);
CREATE INDEX IF NOT EXISTS idx_tx_agent ON transactions (agent_id);
CREATE INDEX IF NOT EXISTS idx_tx_type ON transactions (tx_type);
CREATE INDEX IF NOT EXISTS idx_tx_sync_ts ON transactions (sync_ts DESC);
CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions (status);
CREATE INDEX IF NOT EXISTS idx_tx_to_hash ON transactions (to_hash);
CREATE INDEX IF NOT EXISTS idx_tx_from_hash ON transactions (from_hash);
CREATE INDEX IF NOT EXISTS idx_tx_coin_id ON transactions (coin_id);
CREATE INDEX IF NOT EXISTS idx_tx_mfb ON transactions (mfb_id);

-- ── Functions ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION expire_claims()
 RETURNS void LANGUAGE sql SET search_path TO 'public'
AS $function$
  UPDATE claim_bundles
  SET status = 'EXPIRED'
  WHERE expires_at < NOW() AND status = 'PENDING';
$function$;

CREATE OR REPLACE FUNCTION log_coin_movement()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO coin_ledger (coin_id, amount, event_type, prev_holder_hash, new_holder_hash, prev_status, new_status, changed_at)
    VALUES (NEW.coin_id, NEW.amount, 'MINT', NULL, NEW.holder_hash, NULL, NEW.status, NOW());
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF (NEW.holder_hash IS DISTINCT FROM OLD.holder_hash)
       OR (NEW.status IS DISTINCT FROM OLD.status) THEN
      INSERT INTO coin_ledger (coin_id, amount, event_type, prev_holder_hash, new_holder_hash, prev_status, new_status, changed_at)
      VALUES (
        NEW.coin_id, NEW.amount,
        CASE WHEN NEW.holder_hash IS DISTINCT FROM OLD.holder_hash THEN 'TRANSFER' ELSE 'STATUS_CHANGE' END,
        OLD.holder_hash, NEW.holder_hash, OLD.status, NEW.status, NOW()
      );
    END IF;
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$function$;

-- increment_agent_commission: recreated for completeness, but access is
-- revoked from anon/authenticated/PUBLIC below (see production security
-- fix — this function was found unused and dangerously exposed).
CREATE OR REPLACE FUNCTION increment_agent_commission(p_agent_id text, p_kobo bigint)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE agents
  SET commission_balance_kobo = COALESCE(commission_balance_kobo, 0) + p_kobo
  WHERE agent_id = p_agent_id;
END;
$function$;

CREATE OR REPLACE FUNCTION increment_agent_commission(p_agent_id text, p_kobo integer)
 RETURNS void LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO agent_commission_balance (agent_id, pending_kobo, lifetime_kobo, updated_at)
  VALUES (p_agent_id, p_kobo, p_kobo, now())
  ON CONFLICT (agent_id) DO UPDATE
    SET pending_kobo  = agent_commission_balance.pending_kobo  + EXCLUDED.pending_kobo,
        lifetime_kobo = agent_commission_balance.lifetime_kobo + EXCLUDED.lifetime_kobo,
        updated_at    = now();
END;
$function$;

REVOKE EXECUTE ON FUNCTION increment_agent_commission(text, bigint) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION increment_agent_commission(text, integer) FROM anon, authenticated, PUBLIC;

-- ── Triggers ─────────────────────────────────────────────────
DROP TRIGGER IF EXISTS admin_users_updated_at ON admin_users;
CREATE TRIGGER admin_users_updated_at BEFORE UPDATE ON admin_users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS coins_updated_at ON coins;
CREATE TRIGGER coins_updated_at BEFORE UPDATE ON coins
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_coin_movement ON coins;
CREATE TRIGGER trg_coin_movement AFTER INSERT OR UPDATE ON coins
  FOR EACH ROW EXECUTE FUNCTION log_coin_movement();

-- ── Views (security_invoker per production security fix) ───
CREATE OR REPLACE VIEW admin_permissions AS
 SELECT user_id, username, role, status,
    (role = 'SUPER_ADMIN'::admin_role) AS can_mint,
    (role = ANY (ARRAY['SUPER_ADMIN'::admin_role, 'OPERATIONS'::admin_role])) AS can_float_topup,
    (role = ANY (ARRAY['SUPER_ADMIN'::admin_role, 'OPERATIONS'::admin_role])) AS can_force_reconcile,
    (role = ANY (ARRAY['SUPER_ADMIN'::admin_role, 'COMPLIANCE'::admin_role])) AS can_freeze_coin,
    (role = ANY (ARRAY['SUPER_ADMIN'::admin_role, 'COMPLIANCE'::admin_role])) AS can_suspend_entity,
    (role = ANY (ARRAY['SUPER_ADMIN'::admin_role, 'COMPLIANCE'::admin_role, 'OPERATIONS'::admin_role, 'SUPPORT'::admin_role, 'AUDITOR'::admin_role])) AS can_view_transactions,
    (role = ANY (ARRAY['SUPER_ADMIN'::admin_role, 'COMPLIANCE'::admin_role, 'OPERATIONS'::admin_role, 'SUPPORT'::admin_role])) AS can_view_pii,
    (role <> 'VIEWER'::admin_role) AS can_view_dashboard,
    (role = ANY (ARRAY['SUPER_ADMIN'::admin_role, 'COMPLIANCE'::admin_role, 'OPERATIONS'::admin_role, 'AUDITOR'::admin_role])) AS can_export,
    (role = ANY (ARRAY['SUPER_ADMIN'::admin_role, 'COMPLIANCE'::admin_role, 'AUDITOR'::admin_role])) AS can_view_audit_log,
    (role = 'SUPER_ADMIN'::admin_role) AS can_manage_users,
    (role = 'SUPER_ADMIN'::admin_role) AS can_reset_passwords,
    (role = 'SUPER_ADMIN'::admin_role) AS can_change_config
   FROM admin_users u WHERE (status = 'ACTIVE'::admin_status);
ALTER VIEW admin_permissions SET (security_invoker = true);
REVOKE ALL PRIVILEGES ON admin_permissions FROM anon, authenticated;

CREATE OR REPLACE VIEW daily_tx_summary AS
 SELECT date(sync_ts) AS tx_date, count(*) AS total_txs, sum(amount) AS total_volume_kobo,
    count(*) FILTER (WHERE (status = 'CONFLICT'::tx_status)) AS conflicts,
    count(*) FILTER (WHERE (status = 'SETTLED'::tx_status)) AS settled
   FROM transactions GROUP BY (date(sync_ts)) ORDER BY (date(sync_ts)) DESC;
ALTER VIEW daily_tx_summary SET (security_invoker = true);
REVOKE ALL PRIVILEGES ON daily_tx_summary FROM anon, authenticated;

CREATE OR REPLACE VIEW v_recent_claims AS
 SELECT claim_id, agent_id, ((amount_kobo)::numeric / 100.0) AS amount_naira, coin_count, status,
    pin_required, pin_attempts, created_at, expires_at, claimed_at,
        CASE WHEN (claimed_at IS NOT NULL) THEN (EXTRACT(epoch FROM (claimed_at - created_at)) / (60)::numeric)
            ELSE NULL::numeric END AS minutes_to_claim
   FROM claim_bundles WHERE (created_at > (now() - '7 days'::interval)) ORDER BY created_at DESC;
ALTER VIEW v_recent_claims SET (security_invoker = true);
REVOKE ALL PRIVILEGES ON v_recent_claims FROM anon, authenticated;

CREATE OR REPLACE VIEW wallet_balances AS
 SELECT holder_hash, sum(amount) AS balance_kobo, count(*) AS coin_count, min(expires_at) AS earliest_expiry
   FROM coins WHERE (status = 'HELD'::coin_status) GROUP BY holder_hash;
ALTER VIEW wallet_balances SET (security_invoker = true);
REVOKE ALL PRIVILEGES ON wallet_balances FROM anon, authenticated;

-- coin_ledger_holder_balance — arrivals/departures CTE (bug-corrected
-- version verified against local Postgres earlier this session)
CREATE OR REPLACE VIEW coin_ledger_holder_balance AS
WITH arrivals AS (
  SELECT new_holder_hash AS holder_hash, SUM(amount) AS arrived_kobo, COUNT(*) AS arrival_count, MAX(changed_at) AS last_arrival
  FROM coin_ledger WHERE new_holder_hash IS NOT NULL AND new_status = 'HELD' GROUP BY new_holder_hash
), departures AS (
  SELECT prev_holder_hash AS holder_hash, SUM(amount) AS departed_kobo, COUNT(*) AS departure_count, MAX(changed_at) AS last_departure
  FROM coin_ledger WHERE prev_holder_hash IS NOT NULL AND prev_status = 'HELD'
    AND (new_holder_hash IS DISTINCT FROM prev_holder_hash OR new_status IS DISTINCT FROM 'HELD')
  GROUP BY prev_holder_hash
)
SELECT COALESCE(a.holder_hash, d.holder_hash) AS holder_hash,
  COALESCE(a.arrived_kobo, 0) - COALESCE(d.departed_kobo, 0) AS implied_held_kobo,
  COALESCE(a.arrival_count, 0) + COALESCE(d.departure_count, 0) AS movement_count,
  GREATEST(COALESCE(a.last_arrival, 'epoch'::timestamptz), COALESCE(d.last_departure, 'epoch'::timestamptz)) AS last_movement
FROM arrivals a FULL OUTER JOIN departures d ON a.holder_hash = d.holder_hash;
ALTER VIEW coin_ledger_holder_balance SET (security_invoker = true);
REVOKE ALL PRIVILEGES ON coin_ledger_holder_balance FROM anon, authenticated;

-- ── RLS — enabled everywhere, no policies (service_role only,
--    matching production's deny-by-default posture) ────────────
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_password_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_commission_balance ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_mfb_change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_feed_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE coin_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE float_topups ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfb_partners ENABLE ROW LEVEL SECURITY;
ALTER TABLE otp_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limit_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_alerts ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- POST-MIGRATION CHECKLIST:
-- 1. Run in Supabase SQL Editor on the STAGING project.
-- 2. Verify table count: SELECT COUNT(*) FROM information_schema.tables
--    WHERE table_schema='public' AND table_type='BASE TABLE'; -- expect 21
-- 3. Verify: SELECT * FROM coin_ledger_holder_balance LIMIT 1; (0 rows, no error)
-- ============================================================
