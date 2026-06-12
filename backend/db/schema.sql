-- ============================================================
-- Zillion MVP — Supabase Database Schema
-- Run this in Supabase SQL Editor to initialise the database
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── ENUMS ────────────────────────────────────────────────────────────────────

CREATE TYPE coin_status AS ENUM (
  'ISSUED',     -- Minted, not yet delivered to customer
  'HELD',       -- Held by a user wallet
  'SPENT',      -- Transferred to another user (offline tx settled)
  'REDEEMED',   -- Cashed out at an agent
  'EXPIRED',    -- Past expiry date
  'FROZEN'      -- Frozen pending fraud investigation
);

CREATE TYPE tx_status AS ENUM (
  'SETTLED',    -- Clean transaction, fully settled
  'CONFLICT',   -- Double-spend detected
  'PENDING',    -- Received but not yet processed (queue)
  'REVERSED'    -- Manually reversed by admin
);

-- ── COINS TABLE ───────────────────────────────────────────────────────────────

CREATE TABLE coins (
  coin_id         VARCHAR(64)   PRIMARY KEY,
  amount          BIGINT        NOT NULL CHECK (amount > 0),
  currency        CHAR(3)       NOT NULL DEFAULT 'NGN',
  issued_at       TIMESTAMPTZ   NOT NULL,
  expires_at      TIMESTAMPTZ   NOT NULL,
  issuer_id       VARCHAR(32)   NOT NULL,
  status          coin_status   NOT NULL DEFAULT 'ISSUED',
  holder_hash     VARCHAR(64),
  mint_sig        VARCHAR(256)  NOT NULL,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Indexes for common query patterns
CREATE INDEX idx_coins_status        ON coins (status);
CREATE INDEX idx_coins_holder        ON coins (holder_hash);
CREATE INDEX idx_coins_expires       ON coins (expires_at);
CREATE INDEX idx_coins_status_holder ON coins (status, holder_hash);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER coins_updated_at
  BEFORE UPDATE ON coins
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── TRANSACTIONS TABLE ───────────────────────────────────────────────────────

CREATE TABLE transactions (
  tx_id           VARCHAR(80)   PRIMARY KEY,
  coin_id         VARCHAR(64)   NOT NULL REFERENCES coins(coin_id),
  from_hash       VARCHAR(64)   NOT NULL,
  to_hash         VARCHAR(64)   NOT NULL,
  amount          BIGINT        NOT NULL CHECK (amount > 0),
  tx_ts           TIMESTAMPTZ   NOT NULL,   -- Device timestamp (when offline tx occurred)
  sync_ts         TIMESTAMPTZ   NOT NULL DEFAULT NOW(), -- Server receipt time
  env_sig         VARCHAR(256)  NOT NULL,
  nonce           VARCHAR(64),
  status          tx_status     NOT NULL DEFAULT 'SETTLED',
  conflict_ref    VARCHAR(80),              -- Points to winning tx_id if this is a conflict
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tx_coin_id   ON transactions (coin_id);
CREATE INDEX idx_tx_from_hash ON transactions (from_hash);
CREATE INDEX idx_tx_to_hash   ON transactions (to_hash);
CREATE INDEX idx_tx_status    ON transactions (status);
CREATE INDEX idx_tx_sync_ts   ON transactions (sync_ts DESC);

-- ── FRAUD EVENTS TABLE ───────────────────────────────────────────────────────

CREATE TABLE fraud_events (
  event_id        UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  device_hash     VARCHAR(64)   NOT NULL,
  event_type      VARCHAR(32)   NOT NULL,
  coin_id         VARCHAR(64),
  detected_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  resolved        BOOLEAN       NOT NULL DEFAULT FALSE,
  resolution_note TEXT,
  resolved_at     TIMESTAMPTZ
);

CREATE INDEX idx_fraud_device   ON fraud_events (device_hash);
CREATE INDEX idx_fraud_resolved ON fraud_events (resolved);
CREATE INDEX idx_fraud_type     ON fraud_events (event_type);

-- ── AGENTS TABLE ─────────────────────────────────────────────────────────────

CREATE TABLE agents (
  agent_id            VARCHAR(32)   PRIMARY KEY,
  name                VARCHAR(128)  NOT NULL,
  phone               VARCHAR(20)   NOT NULL UNIQUE,
  location_name       VARCHAR(128),
  float_balance_kobo  BIGINT        NOT NULL DEFAULT 0 CHECK (float_balance_kobo >= 0),
  status              VARCHAR(16)   NOT NULL DEFAULT 'ACTIVE',
  onboarded_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  last_activity       TIMESTAMPTZ
);

-- ── DEVICES TABLE (registered wallets) ───────────────────────────────────────

CREATE TABLE devices (
  device_hash         VARCHAR(64)   PRIMARY KEY,
  phone_hash          VARCHAR(64)   NOT NULL,
  public_key_hex      VARCHAR(256)  NOT NULL,
  registered_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  last_sync           TIMESTAMPTZ,
  fraud_score         INTEGER       NOT NULL DEFAULT 0,
  status              VARCHAR(16)   NOT NULL DEFAULT 'ACTIVE'
);

CREATE INDEX idx_devices_phone ON devices (phone_hash);

-- ── VIEWS ─────────────────────────────────────────────────────────────────────

-- Current wallet balance per holder (settled + held coins)
CREATE VIEW wallet_balances AS
  SELECT
    holder_hash,
    SUM(amount)  AS balance_kobo,
    COUNT(*)     AS coin_count,
    MIN(expires_at) AS earliest_expiry
  FROM coins
  WHERE status = 'HELD'
  GROUP BY holder_hash;

-- Daily transaction summary
CREATE VIEW daily_tx_summary AS
  SELECT
    DATE(sync_ts)     AS tx_date,
    COUNT(*)          AS total_txs,
    SUM(amount)       AS total_volume_kobo,
    COUNT(*) FILTER (WHERE status = 'CONFLICT') AS conflicts,
    COUNT(*) FILTER (WHERE status = 'SETTLED')  AS settled
  FROM transactions
  GROUP BY DATE(sync_ts)
  ORDER BY tx_date DESC;

-- ── ROW LEVEL SECURITY ───────────────────────────────────────────────────────
-- All tables are service-role access only from Netlify functions.
-- No direct client access permitted.

ALTER TABLE coins          ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE fraud_events   ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents         ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices        ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS by default in Supabase — no policies needed
-- for server-side access. Anon access is fully blocked.

-- ── SEED DATA (Pilot Agents) ──────────────────────────────────────────────────

INSERT INTO agents (agent_id, name, phone, location_name, float_balance_kobo) VALUES
  ('AGENT-00001', 'Kola Adekunle', '+2348023456789', 'Mushin Market Kiosk A',    500000),
  ('AGENT-00002', 'Bisi Okonkwo',  '+2348034567890', 'Agege Motor Road Kiosk',   300000),
  ('AGENT-00003', 'Emeka Nwosu',   '+2348045678901', 'Mushin Market Kiosk B',    400000),
  ('AGENT-00004', 'Fatima Bello',  '+2348056789012', 'Agege Central Kiosk',      250000),
  ('AGENT-00005', 'Yusuf Musa',    '+2348067890123', 'Iyana Ipaja Junction Kiosk',350000);

-- ============================================================
-- END OF SCHEMA
-- Total float loaded: ₦18,000 across 5 pilot agents
-- ============================================================
