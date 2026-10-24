-- Go-live catch-up: savings withdrawals. The savings table only allowed a negative amount for a loan repayment taken
-- from savings. A member's withdrawal is also a negative entry, so the rule now allows it under its own source.
-- Idempotent: safe to re-run.
ALTER TABLE coop_savings_transactions DROP CONSTRAINT IF EXISTS coop_savings_transactions_amount_kobo_check;
ALTER TABLE coop_savings_transactions ADD CONSTRAINT coop_savings_transactions_amount_kobo_check CHECK (
  (source IN ('loan_repayment_deduction', 'member_withdrawal') AND amount_kobo < 0)
  OR (source NOT IN ('loan_repayment_deduction', 'member_withdrawal') AND amount_kobo > 0)
);
