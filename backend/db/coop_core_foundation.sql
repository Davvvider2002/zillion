-- ============================================================
-- ZILLION — Cooperative Thrift & Loan module (foundation)
-- Applied directly to production AND staging.
--
-- coop_societies: a society's own payment identity is its linked
-- Merchant record (merchant_id) — Send/Receive already works via
-- the existing merchant rails, nothing new needed there.
--
-- coop_members: a member is an existing Zillion identity linked to
-- a society. Admin can activate a member BEFORE they've ever opened
-- the app (pre-provisioning) — see coop-activate-member.js, which
-- mirrors bank-activate-customer.js's pattern (and fixes a real bug
-- found in that pattern along the way — see crypto.js's
-- computeWalletDeviceHash).
-- ============================================================

CREATE TABLE IF NOT EXISTS coop_societies (
  coop_id         TEXT PRIMARY KEY DEFAULT ('COOPSOC-' || upper(substr(md5(random()::text), 1, 8))),
  merchant_id     TEXT NOT NULL,
  name            TEXT NOT NULL,
  lascofed_ref    TEXT,           -- institutional checklist reference, not a live integration
  status          TEXT NOT NULL DEFAULT 'TRIAL',  -- TRIAL | ACTIVE | SUSPENDED
  trial_ends_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS coop_members (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coop_id               TEXT NOT NULL REFERENCES coop_societies(coop_id),
  zillion_id            TEXT,
  phone_normalized      TEXT NOT NULL,
  name                  TEXT,
  opening_balance_kobo  BIGINT NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'ACTIVE',
  activated_by          TEXT,
  activated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(coop_id, phone_normalized)
);

CREATE INDEX IF NOT EXISTS idx_coop_members_coop ON coop_members(coop_id);
CREATE INDEX IF NOT EXISTS idx_coop_members_zid  ON coop_members(zillion_id);

ALTER TABLE coop_societies ENABLE ROW LEVEL SECURITY;
ALTER TABLE coop_members ENABLE ROW LEVEL SECURITY;
