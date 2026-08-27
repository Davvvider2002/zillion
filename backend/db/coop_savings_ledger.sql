-- ============================================================
-- ZILLION — Cooperative Thrift & Loan: savings ledger
-- Applied directly to production AND staging.
--
-- Genuinely separate from coins/coin_ledger — savings payments are
-- bank transfers into a member's own dedicated account, not Zil
-- transfers. Zil balance and Thrift & Loan balance are two entirely
-- independent funding paths, per David's explicit correction.
--
-- Interim: admin manually confirms a bank transfer happened and
-- records it here (source='bank_transfer_manual') — matching the
-- exact "admin sees proof, manually verifies, credits" step from the
-- original pain point, before any automation existed. Once the
-- Moniepoint/OPay webhook integration is live, it writes to this same
-- table (source='webhook_moniepoint'/'webhook_opay') automatically —
-- no change needed to this schema or to how balances are computed.
--
-- savings_plan_id is required on every row (not inferred from date
-- ranges) — this is also what fixes a real ambiguity found during
-- testing: a member with multiple savings plans needs each payment
-- explicitly attributed to the right one, not guessed at.
-- ============================================================

CREATE TABLE IF NOT EXISTS coop_savings_transactions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coop_id           TEXT NOT NULL REFERENCES coop_societies(coop_id),
  member_id         UUID NOT NULL REFERENCES coop_members(id),
  savings_plan_id   UUID NOT NULL REFERENCES coop_savings_plans(id),
  amount_kobo       BIGINT NOT NULL CHECK (amount_kobo > 0),
  source            TEXT NOT NULL DEFAULT 'bank_transfer_manual',
  reference         TEXT,
  recorded_by       TEXT NOT NULL,
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_savings_txn_plan   ON coop_savings_transactions(savings_plan_id);
CREATE INDEX IF NOT EXISTS idx_savings_txn_member ON coop_savings_transactions(member_id);
ALTER TABLE coop_savings_transactions ENABLE ROW LEVEL SECURITY;
