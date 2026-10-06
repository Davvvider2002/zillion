-- Flutterwave ledger: every payment Flutterwave collects for a society, every settlement it pays out, with the matching
-- journal entries and a balance that is - by construction - the money Flutterwave still holds for the society.
--
-- Until now an online payment was booked straight to the society's Bank account, as though it landed there the moment the
-- member paid. In reality it sits in Flutterwave until settlement (typically next day), so the books ran ahead of the real
-- bank statement and settlement deposits had nothing to match against. Now:
--   member pays          Dr 1020 Flutterwave Collections (Unsettled)   Cr savings / dues / loan / shares / income ...
--   Flutterwave settles  Dr <settlement bank account>   (Dr 5200 Bank Charges for any fee deducted)   Cr 1020
-- The 1020 balance = payments received - settlements paid out = what Flutterwave still holds.
-- No online payment had ever been booked when this was introduced, so nothing needed restating.

-- 1. which of the society's bank accounts Flutterwave settles into (a stable account CODE, not an id: societies are restored
--    before their chart of accounts, so a foreign key here would break a restore). NULL = 1010 Bank Account.
ALTER TABLE coop_societies ADD COLUMN IF NOT EXISTS settlement_account_code text;

-- 2. the ledger
CREATE TABLE IF NOT EXISTS coop_flutterwave_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coop_id text NOT NULL REFERENCES coop_societies(coop_id),
  direction text NOT NULL CHECK (direction IN ('IN','OUT')),
  entry_type text NOT NULL CHECK (entry_type IN ('PAYMENT','SETTLEMENT')),
  amount_kobo bigint NOT NULL CHECK (amount_kobo > 0),     -- the SOCIETY's money: what it received / what was settled to its bank
  gross_kobo bigint,                                       -- payments: what the payer actually paid; settlements: Flutterwave's gross
  fees_kobo bigint NOT NULL DEFAULT 0,                     -- payments: charges the payer added on top (not the society's); settlements: fee Flutterwave deducted
  live_mode boolean NOT NULL,                              -- only live payments ever settle; test ones are kept but never counted as "owed"
  purpose text,                                            -- savings | dues | loan_repayment | shares | investment | joining_fee | settlement
  channel text NOT NULL DEFAULT 'checkout' CHECK (channel IN ('checkout','virtual_account')),  -- checkout = split to the society's sub-account, settles to its bank; virtual_account = bank transfer into a member's virtual account, which lands in ZILLION's balance (no split) and is owed on to the society
  member_id uuid REFERENCES coop_members(id),
  counterparty_name text,
  counterparty_phone text,
  narration text,
  flw_transaction_id text,
  flw_tx_ref text,
  flw_settlement_id text,
  settled_in text,                                         -- PAYMENT rows: the settlement that paid it out (NULL = still held by Flutterwave)
  settled_at timestamptz,
  settlement_account_number text,                          -- SETTLEMENT rows: where Flutterwave says it paid
  account_matches boolean,                                 -- SETTLEMENT rows: that account is the society's configured one? (NULL = Flutterwave did not say)
  expected_kobo bigint,                                    -- SETTLEMENT rows: sum of the ledgered payments it covers
  variance_kobo bigint,                                    -- SETTLEMENT rows: amount - expected (non-zero = needs explaining)
  match_status text,                                       -- PAYMENT: HELD | SETTLED ; SETTLEMENT: MATCHED | VARIANCE | UNKNOWN_TRANSACTIONS
  journal_entry_id uuid REFERENCES coop_journal_entries(id),
  provider_data jsonb,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- one ledger row per Flutterwave transaction / settlement: the database, not the application, refuses a double-count
CREATE UNIQUE INDEX IF NOT EXISTS uq_flw_ledger_payment ON coop_flutterwave_ledger (coop_id, flw_transaction_id) WHERE entry_type = 'PAYMENT' AND flw_transaction_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_flw_ledger_settlement ON coop_flutterwave_ledger (coop_id, flw_settlement_id) WHERE entry_type = 'SETTLEMENT';
CREATE INDEX IF NOT EXISTS idx_flw_ledger_coop_time ON coop_flutterwave_ledger (coop_id, occurred_at, id);
CREATE INDEX IF NOT EXISTS idx_flw_ledger_held ON coop_flutterwave_ledger (coop_id) WHERE entry_type = 'PAYMENT' AND settled_in IS NULL;
ALTER TABLE coop_flutterwave_ledger ENABLE ROW LEVEL SECURITY;

-- 3. the two new system accounts, for every society that already has accounting set up
INSERT INTO coop_chart_of_accounts (coop_id, account_code, account_name, account_type, currency, is_system, active, sub_type)
SELECT a.coop_id, v.code, v.name, v.type, a.currency, true, true, v.sub
FROM coop_chart_of_accounts a
CROSS JOIN (VALUES ('1020','Flutterwave Collections (Unsettled)','ASSET','other_assets'), ('4120','Joining & Registration Fees','INCOME','direct_income')) v(code, name, type, sub)
WHERE a.account_code = '1010'
ON CONFLICT (coop_id, account_code) DO NOTHING;

-- 4. the books' own view of the clearing account, added up by the database (one small answer, not every journal line)
CREATE OR REPLACE FUNCTION coop_clearing_totals(p_coop_id text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT jsonb_build_object(
    'debit_kobo',  coalesce(sum(l.base_amount) FILTER (WHERE lower(l.line_type) = 'debit'), 0)::bigint,
    'credit_kobo', coalesce(sum(l.base_amount) FILTER (WHERE lower(l.line_type) = 'credit'), 0)::bigint)
  FROM coop_journal_entry_lines l JOIN coop_chart_of_accounts a ON a.id = l.account_id
  WHERE l.coop_id = p_coop_id AND a.account_code = '1020'
$$;
REVOKE ALL ON FUNCTION coop_clearing_totals(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION coop_clearing_totals(text) TO service_role;

-- 5. backups: after the journal entries and members it points to
INSERT INTO backup_registry (table_name, scope_sql, pk_cols, insert_order, restore) VALUES
  ('coop_flutterwave_ledger', 'coop_id = $1', ARRAY['id'], 55, true)
ON CONFLICT (table_name) DO NOTHING;

-- 6. ledger totals added up by the database (opening balance before a date range, current balance): one small answer
--    instead of downloading every row. p_before NULL = all time; p_live_only restricts to live-mode rows.
CREATE OR REPLACE FUNCTION coop_flutterwave_ledger_totals(p_coop_id text, p_before timestamptz, p_live_only boolean) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT jsonb_build_object(
    'in_kobo',  coalesce(sum(amount_kobo) FILTER (WHERE direction = 'IN'), 0)::bigint,
    'out_kobo', coalesce(sum(amount_kobo) FILTER (WHERE direction = 'OUT'), 0)::bigint)
  FROM coop_flutterwave_ledger
  WHERE coop_id = p_coop_id AND (p_before IS NULL OR occurred_at < p_before) AND (NOT p_live_only OR live_mode)
$$;
REVOKE ALL ON FUNCTION coop_flutterwave_ledger_totals(text, timestamptz, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION coop_flutterwave_ledger_totals(text, timestamptz, boolean) TO service_role;

-- (for databases created before the channel column existed)
ALTER TABLE coop_flutterwave_ledger ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'checkout' CHECK (channel IN ('checkout','virtual_account'));

-- 7. platform-wide view for Zillion: one row per society, all added up by the database in a single pass (no per-society loop).
--    Compares the ledger with the books' own balance on 1020 for EVERY society, including one that has books activity but no
--    ledger rows at all (a payment booked without being ledgered). 'owed' = bank transfers that landed in Zillion's balance.
CREATE OR REPLACE FUNCTION coop_flutterwave_platform_summary() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH led AS (
    SELECT coop_id,
      coalesce(sum(amount_kobo) FILTER (WHERE direction = 'IN'  AND live_mode), 0)::bigint AS in_kobo,
      coalesce(sum(amount_kobo) FILTER (WHERE direction = 'OUT' AND live_mode), 0)::bigint AS out_kobo,
      (coalesce(sum(amount_kobo) FILTER (WHERE direction = 'IN'), 0) - coalesce(sum(amount_kobo) FILTER (WHERE direction = 'OUT'), 0))::bigint AS all_modes_balance_kobo,
      coalesce(sum(amount_kobo) FILTER (WHERE entry_type = 'PAYMENT' AND live_mode AND channel = 'checkout' AND settled_in IS NULL), 0)::bigint AS held_kobo,
      count(*) FILTER (WHERE entry_type = 'PAYMENT' AND live_mode AND channel = 'checkout' AND settled_in IS NULL) AS held_count,
      min(occurred_at) FILTER (WHERE entry_type = 'PAYMENT' AND live_mode AND channel = 'checkout' AND settled_in IS NULL) AS oldest_held_at,
      coalesce(sum(amount_kobo) FILTER (WHERE entry_type = 'PAYMENT' AND live_mode AND channel = 'virtual_account' AND settled_in IS NULL), 0)::bigint AS owed_kobo,
      count(*) FILTER (WHERE entry_type = 'PAYMENT' AND live_mode AND channel = 'virtual_account' AND settled_in IS NULL) AS owed_count,
      max(occurred_at) FILTER (WHERE entry_type = 'SETTLEMENT') AS last_settlement_at,
      count(*) FILTER (WHERE entry_type = 'SETTLEMENT' AND match_status <> 'MATCHED') AS unmatched_settlements,
      count(*) FILTER (WHERE entry_type = 'SETTLEMENT' AND account_matches = false) AS wrong_account_settlements,
      count(*) FILTER (WHERE NOT live_mode) AS test_rows,
      count(*) FILTER (WHERE journal_entry_id IS NULL) AS rows_without_journal
    FROM coop_flutterwave_ledger GROUP BY coop_id),
  gl AS (
    SELECT l.coop_id, sum(CASE WHEN lower(l.line_type) = 'debit' THEN l.base_amount ELSE -l.base_amount END)::bigint AS gl_kobo
    FROM coop_journal_entry_lines l JOIN coop_chart_of_accounts a ON a.id = l.account_id
    WHERE a.account_code = '1020' GROUP BY l.coop_id)
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.coop_id), '[]'::jsonb) FROM (
    SELECT coalesce(led.coop_id, gl.coop_id) AS coop_id,
      coalesce(led.in_kobo, 0) AS in_kobo, coalesce(led.out_kobo, 0) AS out_kobo,
      coalesce(led.held_kobo, 0) AS held_kobo, coalesce(led.held_count, 0) AS held_count, led.oldest_held_at,
      coalesce(led.owed_kobo, 0) AS owed_kobo, coalesce(led.owed_count, 0) AS owed_count, led.last_settlement_at,
      coalesce(led.unmatched_settlements, 0) AS unmatched_settlements, coalesce(led.wrong_account_settlements, 0) AS wrong_account_settlements,
      coalesce(led.test_rows, 0) AS test_rows, coalesce(led.rows_without_journal, 0) AS rows_without_journal,
      coalesce(gl.gl_kobo, 0) AS gl_kobo, (coalesce(gl.gl_kobo, 0) - coalesce(led.all_modes_balance_kobo, 0))::bigint AS difference_kobo
    FROM led FULL JOIN gl ON gl.coop_id = led.coop_id) t
$$;
REVOKE ALL ON FUNCTION coop_flutterwave_platform_summary() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION coop_flutterwave_platform_summary() TO service_role;
