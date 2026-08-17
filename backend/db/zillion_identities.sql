-- ============================================================
-- ZILLION — Unified Zillion ID
-- Applied directly to production AND staging. One identity per
-- PERSON (not per role) — wallet, merchant, and agent records all
-- link back to the same zillion_id when they share a phone number.
-- Roles become attributes of one identity, not separate identity
-- systems.
--
-- IMPORTANT CONSTRAINT: wallet identity (devices table) is stored
-- as one-way cryptographic hashes — the real phone number CANNOT
-- be recovered from what's already stored. This means:
--   - agents/merchants (phone stored in plain text already): can be
--     backfilled immediately, one-time script.
--   - existing wallet users: zillion_id can only be linked the next
--     time their real phone number passes through the system in
--     cleartext — verify-otp.js, which runs on every login, not
--     just first-time registration. This is a lazy, gradual
--     backfill for wallet identities, not a one-time script.
-- ============================================================

CREATE TABLE IF NOT EXISTS zillion_identities (
  zillion_id       TEXT PRIMARY KEY DEFAULT ('ZIL-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 10))),
  phone_normalized TEXT NOT NULL UNIQUE,
  first_seen_as    TEXT,  -- informational only ('wallet'/'merchant'/'agent'/'bank_customer'), not authoritative — actual roles are derived by joining devices/merchants/agents on zillion_id
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_zillion_identities_phone ON zillion_identities(phone_normalized);

ALTER TABLE devices   ADD COLUMN IF NOT EXISTS zillion_id TEXT REFERENCES zillion_identities(zillion_id);
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS zillion_id TEXT REFERENCES zillion_identities(zillion_id);
ALTER TABLE agents    ADD COLUMN IF NOT EXISTS zillion_id TEXT REFERENCES zillion_identities(zillion_id);

CREATE INDEX IF NOT EXISTS idx_devices_zid   ON devices(zillion_id);
CREATE INDEX IF NOT EXISTS idx_merchants_zid ON merchants(zillion_id);
CREATE INDEX IF NOT EXISTS idx_agents_zid    ON agents(zillion_id);

ALTER TABLE zillion_identities ENABLE ROW LEVEL SECURITY;
