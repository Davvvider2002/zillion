-- ============================================================
-- ZILLION — Flutterwave savings integration
-- Applied directly to production AND staging.
--
-- Second, independent payment rail alongside Moniepoint/OPay —
-- coop_savings_transactions.source already anticipated this
-- ('webhook_flutterwave' joins 'bank_transfer_manual' and the
-- Moniepoint/OPay placeholders with zero schema change needed there).
--
-- flutterwave_tx_ref is the reference Zillion assigns when
-- provisioning a member's virtual account — Flutterwave echoes it
-- back in webhook payloads, which is how an incoming payment gets
-- mapped to the right savings plan.
--
-- The partial unique index on coop_savings_transactions.reference
-- enforces webhook idempotency at the DATABASE level, not just in
-- application code — verified locally that a genuine duplicate
-- webhook retry (which Flutterwave's own docs say can happen) is
-- correctly rejected, not silently double-processed.
-- ============================================================

ALTER TABLE coop_savings_plans ADD COLUMN IF NOT EXISTS flutterwave_tx_ref TEXT UNIQUE;
ALTER TABLE coop_savings_plans ADD COLUMN IF NOT EXISTS flutterwave_account_number TEXT;
ALTER TABLE coop_savings_plans ADD COLUMN IF NOT EXISTS flutterwave_bank_name TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_savings_txn_reference_unique
  ON coop_savings_transactions(reference) WHERE reference IS NOT NULL;
