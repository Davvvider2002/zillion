-- 2026-10-14: bank statement import (balances read from the statement) + Micro/Starter bundles.
-- Safe to run more than once.

-- 1. Where a reconciliation's opening/closing balance came from, and which bank account number the statement said it was.
ALTER TABLE coop_bank_reconciliation_batches ADD COLUMN IF NOT EXISTS balances_source TEXT;            -- 'statement' | 'manual' | NULL
ALTER TABLE coop_bank_reconciliation_batches ADD COLUMN IF NOT EXISTS statement_account_number TEXT;

-- 2. The bundle plans. Yearly only. Prices in kobo: Micro N100,000 (1-50 members), Starter N180,000 (51-100 members).
INSERT INTO coop_subscription_plan_catalog (tier, cycle, amount_kobo, member_cap) VALUES
  ('micro_bundle',   'yearly', 10000000, 50),
  ('starter_bundle', 'yearly', 18000000, 100)
ON CONFLICT (tier, cycle) DO NOTHING;

-- 3. Single-use sign-up links that Zillion Admin issues for a bundle. Never exposed to the public; only the service role reads this table.
CREATE TABLE IF NOT EXISTS coop_bundle_links (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code             TEXT NOT NULL UNIQUE,
  tier             TEXT NOT NULL CHECK (tier IN ('micro_bundle', 'starter_bundle')),
  note             TEXT,
  agent_id         UUID,                       -- the agent who asked for it (their referral gets the society)
  created_by       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ NOT NULL,
  used_at          TIMESTAMPTZ,
  used_by_coop_id  TEXT,
  revoked_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_coop_bundle_links_created ON coop_bundle_links(created_at DESC);
ALTER TABLE coop_bundle_links ENABLE ROW LEVEL SECURITY;
