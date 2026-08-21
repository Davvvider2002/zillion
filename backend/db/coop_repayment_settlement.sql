-- ============================================================
-- ZILLION — Multi-tenant settlement (Flutterwave Subaccounts) +
--           Loan repayment system (schedule, tracking, late fees)
-- Applied directly to production AND staging.
--
-- SETTLEMENT: coop_societies.flutterwave_subaccount_id links each
-- society to its own real bank account via Flutterwave's Subaccounts
-- feature (confirmed via their own docs — split payments only work
-- with automatic settlement, confirmed as David's actual setup).
--
-- FEES: Zillion's platform fee matches Flutterwave's own rate,
-- per David's explicit instruction — both calculated the same way
-- (2% + 7.5% VAT on that fee, confirmed current rate from
-- Flutterwave's own help center, not an estimate). The society's
-- subaccount receives a FLAT split equal to exactly the base amount
-- — everything else (both fee portions) stays with Zillion's main
-- account automatically, since subaccounts only receive what's
-- explicitly allocated to them.
--
-- REPAYMENT: same "never a stored, mutable balance" philosophy as
-- savings/dues throughout this module. coop_loan_repayment_schedule
-- is generated ONCE at disbursement (immutable reference data, not
-- a status-tracked table) — tested locally that ceil()-rounded
-- monthly amounts are corrected on the final period so the schedule
-- sums to EXACTLY the principal, never more. Outstanding is always
-- computed live: SUM(schedule where due_date <= today) -
-- SUM(coop_loan_repayments), same pattern proven for dues.
-- ============================================================

ALTER TABLE coop_societies ADD COLUMN IF NOT EXISTS flutterwave_subaccount_id TEXT;
ALTER TABLE coop_societies ADD COLUMN IF NOT EXISTS settlement_bank_code TEXT;
ALTER TABLE coop_societies ADD COLUMN IF NOT EXISTS settlement_account_number TEXT;
ALTER TABLE coop_societies ADD COLUMN IF NOT EXISTS settlement_account_name TEXT;
ALTER TABLE coop_societies ADD COLUMN IF NOT EXISTS late_fee_type TEXT NOT NULL DEFAULT 'flat';
ALTER TABLE coop_societies ADD COLUMN IF NOT EXISTS late_fee_value BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS coop_loan_repayment_schedule (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id         UUID NOT NULL REFERENCES coop_loans(id),
  period_number   INTEGER NOT NULL,
  due_date        DATE NOT NULL,
  amount_due_kobo BIGINT NOT NULL CHECK (amount_due_kobo > 0),
  UNIQUE(loan_id, period_number)
);
CREATE INDEX IF NOT EXISTS idx_repay_schedule_loan ON coop_loan_repayment_schedule(loan_id);
ALTER TABLE coop_loan_repayment_schedule ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS coop_loan_repayments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id      UUID NOT NULL REFERENCES coop_loans(id),
  amount_kobo  BIGINT NOT NULL CHECK (amount_kobo > 0),
  source       TEXT NOT NULL,  -- bank_transfer_manual | cash_in_person | flutterwave_checkout | savings_deduction | offline_zil
  reference    TEXT,
  recorded_by  TEXT NOT NULL,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_repayments_loan ON coop_loan_repayments(loan_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_repayments_reference_unique ON coop_loan_repayments(reference) WHERE reference IS NOT NULL;
ALTER TABLE coop_loan_repayments ENABLE ROW LEVEL SECURITY;
