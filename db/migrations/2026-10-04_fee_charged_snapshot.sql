-- Record, at the moment checkout starts, exactly what the customer was asked to pay and how much of it was
-- Zillion's own fee. Verification then checks the payment against THIS figure instead of re-deriving it from
-- the current fee formula - so a payment started under one fee can never be judged against another, and
-- revenue history stays correct after any future rate change. Nullable: rows created before this existed
-- fall back to the formula (see lib/coopFees.js expectedTotalKobo). Applied to staging then production.
ALTER TABLE coop_checkout_sessions ADD COLUMN IF NOT EXISTS total_charged_kobo bigint, ADD COLUMN IF NOT EXISTS zillion_fee_kobo bigint;
ALTER TABLE coop_join_applications ADD COLUMN IF NOT EXISTS total_charged_kobo bigint, ADD COLUMN IF NOT EXISTS zillion_fee_kobo bigint;
ALTER TABLE ajo_collector_join_applications ADD COLUMN IF NOT EXISTS total_charged_kobo bigint, ADD COLUMN IF NOT EXISTS zillion_fee_kobo bigint;
