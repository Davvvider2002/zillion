-- The application treats NULL as "no late fee" everywhere (readers test `if (type)`, forms use `type || ''`), and the
-- loan-penalty endpoint offers an explicit 'none' opt-out that every reader already handles. The schema disagreed:
-- late_fee_type was NOT NULL DEFAULT 'flat', and the loan check allowed only NULL/flat/percentage. Result: saving
-- "no late fee" for dues, or "no loan penalty", failed with a constraint error. Align the schema with the code.
-- late_fee_value stays NOT NULL DEFAULT 0 (the endpoint now writes 0 when there is no late fee).
-- Applied to staging then production; verified on both with a rolled-back dry run of the exact failing updates.
ALTER TABLE coop_societies ALTER COLUMN late_fee_type DROP NOT NULL;
ALTER TABLE coop_societies ALTER COLUMN late_fee_type DROP DEFAULT;
-- 'flat' with a value of 0 was just the old default standing in for "never configured" - same behaviour, truthful now.
UPDATE coop_societies SET late_fee_type = NULL WHERE late_fee_type = 'flat' AND late_fee_value = 0;
ALTER TABLE coop_societies DROP CONSTRAINT IF EXISTS coop_societies_late_fee_type_check;
ALTER TABLE coop_societies ADD CONSTRAINT coop_societies_late_fee_type_check CHECK (late_fee_type IS NULL OR late_fee_type IN ('flat','percentage'));
ALTER TABLE coop_societies DROP CONSTRAINT IF EXISTS coop_societies_loan_late_fee_type_check;
ALTER TABLE coop_societies ADD CONSTRAINT coop_societies_loan_late_fee_type_check CHECK (loan_late_fee_type IS NULL OR loan_late_fee_type IN ('none','flat','percentage'));
