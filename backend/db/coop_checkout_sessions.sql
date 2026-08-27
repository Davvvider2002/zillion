-- ============================================================
-- ZILLION — Flutterwave v3 Standard Checkout (hosted, in-app)
-- Applied directly to production AND staging.
--
-- Genuinely separate integration from the v4/OAuth virtual-account
-- system already built — Flutterwave's own public documentation
-- confirms v4 has no hosted checkout yet ("still in work, coming
-- soon"), so this specific feature uses v3's mature Standard Checkout
-- (POST /v3/payments), which requires the older static Public/Secret
-- Key auth model, not v4's OAuth client credentials. Two Flutterwave
-- API generations coexisting for two different features — a real
-- architectural seam, not an oversight.
--
-- coop_checkout_sessions exists so the verification step never trusts
-- client-claimed amount/type — it looks up what THIS specific tx_ref
-- was actually created for for and verifies the real payment matches,
-- same "never trust the client for financial crediting" principle
-- used throughout every other payment path this session.
-- ============================================================

CREATE TABLE IF NOT EXISTS coop_checkout_sessions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_ref              TEXT NOT NULL UNIQUE,
  coop_id             TEXT NOT NULL REFERENCES coop_societies(coop_id),
  member_id           UUID NOT NULL REFERENCES coop_members(id),
  type                TEXT NOT NULL,  -- 'savings' | 'dues'
  savings_plan_id     UUID REFERENCES coop_savings_plans(id),
  amount_kobo         BIGINT NOT NULL CHECK (amount_kobo > 0),
  status              TEXT NOT NULL DEFAULT 'pending',  -- pending | completed | failed
  flw_transaction_id  TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_checkout_member ON coop_checkout_sessions(member_id);
ALTER TABLE coop_checkout_sessions ENABLE ROW LEVEL SECURITY;
