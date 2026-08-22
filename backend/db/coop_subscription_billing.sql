-- ============================================================
-- ZILLION — Recurring subscription billing for Thrift & Loan
-- Applied directly to production AND staging.
--
-- Plan structure (David's own numbers, not estimated):
-- Launch/Growth/Scale × monthly/yearly, yearly = 15% off monthly×12.
-- Enterprise stays quotation-based, no self-service checkout.
--
-- Payment alone never activates a society — subscription_status
-- stays 'pending_verification' until an admin explicitly activates
-- via admin-activate-coop-subscription.js, per explicit instruction.
--
-- Grace period on renewal failure: 7 days past subscription_paid_until
-- before a society is actually suspended (scheduled-reconcile.js) —
-- no one loses access the moment a single card charge fails.
-- ============================================================

ALTER TABLE coop_societies ADD COLUMN IF NOT EXISTS subscription_status TEXT NOT NULL DEFAULT 'pending_verification';
ALTER TABLE coop_societies ADD COLUMN IF NOT EXISTS subscription_plan TEXT;
ALTER TABLE coop_societies ADD COLUMN IF NOT EXISTS subscription_cycle TEXT;
ALTER TABLE coop_societies ADD COLUMN IF NOT EXISTS subscription_paid_until TIMESTAMPTZ;
ALTER TABLE coop_societies ADD COLUMN IF NOT EXISTS subscription_email TEXT;
ALTER TABLE coop_societies ADD COLUMN IF NOT EXISTS flutterwave_payment_plan_id TEXT;
ALTER TABLE coop_societies ADD COLUMN IF NOT EXISTS signup_source TEXT NOT NULL DEFAULT 'admin_created';

CREATE TABLE IF NOT EXISTS coop_subscription_plan_catalog (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier                  TEXT NOT NULL,
  cycle                 TEXT NOT NULL,
  amount_kobo           BIGINT NOT NULL,
  member_cap            INTEGER,
  flutterwave_plan_id   TEXT,
  UNIQUE(tier, cycle)
);
ALTER TABLE coop_subscription_plan_catalog ENABLE ROW LEVEL SECURITY;

INSERT INTO coop_subscription_plan_catalog (tier, cycle, amount_kobo, member_cap) VALUES
  ('launch', 'monthly', 990000, 100),
  ('launch', 'yearly', 10098000, 100),
  ('growth', 'monthly', 2490000, 500),
  ('growth', 'yearly', 25398000, 500),
  ('scale', 'monthly', 4990000, 2000),
  ('scale', 'yearly', 50898000, 2000)
ON CONFLICT (tier, cycle) DO NOTHING;

CREATE TABLE IF NOT EXISTS coop_subscription_payments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coop_id         TEXT NOT NULL REFERENCES coop_societies(coop_id),
  amount_kobo     BIGINT NOT NULL,
  type            TEXT NOT NULL,  -- 'initial' | 'renewal'
  status          TEXT NOT NULL,  -- 'success' | 'failed'
  flw_transaction_id TEXT,
  tx_ref          TEXT,
  paid_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sub_payments_coop ON coop_subscription_payments(coop_id);
ALTER TABLE coop_subscription_payments ENABLE ROW LEVEL SECURITY;
