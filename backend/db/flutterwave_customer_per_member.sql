-- ============================================================
-- ZILLION — Flutterwave: customer tracked per member, not per plan
-- Applied directly to production AND staging.
--
-- A Flutterwave "customer" represents a PERSON, not a savings goal.
-- Found via real testing: provisioning a second savings plan for the
-- same member failed with RESOURCE_CONFLICT ("Customer already
-- exists") because the synthetic email is derived from phone number
-- alone — every plan belonging to the same member generates an
-- identical email. The fix is architectural, not a workaround: create
-- the Flutterwave customer once per member, store it here, and reuse
-- it across however many savings plans that member has. Each plan
-- still gets its own separate virtual account (flutterwave_tx_ref /
-- account_number / bank_name on coop_savings_plans, unchanged) — only
-- the underlying customer record is now shared.
-- ============================================================

ALTER TABLE coop_members ADD COLUMN IF NOT EXISTS flutterwave_customer_id TEXT;
