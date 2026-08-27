-- ============================================================
-- ZILLION — Coop society creation support
-- Applied directly to production AND staging.
--
-- opening_loan_capital_kobo / opening_bank_balance_kobo: explicitly
-- requested early in planning ("Opening balances for Loans management,
-- Bank Balances etc must be available" at society setup) — reference
-- figures captured once at creation, shown in the admin dashboard.
-- Deliberately NOT deeply integrated into loan-approval logic (e.g.
-- "block disbursement if it would exceed capital") — that level of
-- real accounting enforcement belongs to the already-deferred
-- Accounting & Expenditures module, not bolted on here.
--
-- phone / owner_name: the society's own contact details, distinct
-- from the linked merchant record's own phone (which is the society's
-- payment identity, not necessarily its contact person).
-- ============================================================

ALTER TABLE coop_societies ADD COLUMN IF NOT EXISTS opening_loan_capital_kobo BIGINT NOT NULL DEFAULT 0;
ALTER TABLE coop_societies ADD COLUMN IF NOT EXISTS opening_bank_balance_kobo BIGINT NOT NULL DEFAULT 0;
ALTER TABLE coop_societies ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE coop_societies ADD COLUMN IF NOT EXISTS owner_name TEXT;
