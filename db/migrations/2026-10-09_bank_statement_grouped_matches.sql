-- Grouped bank-statement matches: ONE bank line explained by SEVERAL records (a batch deposit made up of several receipts, one payment
-- that settles several items). A statement line can point at only one record, so the components of a group are listed here, each with a
-- snapshot of what it was (date, amount, description) so the match stays readable even if the entry is later edited or deleted.
-- Grouping is always a PERSON's decision, confirmed against the exact total (the application refuses a group that does not add up to the
-- kobo). The unique index means a record can explain at most one thing per statement upload, enforced by the database itself.
CREATE TABLE IF NOT EXISTS coop_bank_statement_line_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coop_id text NOT NULL REFERENCES coop_societies(coop_id),
  statement_line_id uuid NOT NULL REFERENCES coop_bank_statement_lines(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL,
  component_type text NOT NULL,            -- journal_entry | flutterwave_settlement | loan_disbursement | loan_repayment
  component_id uuid NOT NULL,
  amount_kobo bigint NOT NULL CHECK (amount_kobo > 0),
  record_date date,
  description text,
  matched_by text NOT NULL,
  matched_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_stmt_match_component ON coop_bank_statement_line_matches (batch_id, component_type, component_id);
CREATE INDEX IF NOT EXISTS idx_stmt_match_line ON coop_bank_statement_line_matches (statement_line_id);
ALTER TABLE coop_bank_statement_line_matches ENABLE ROW LEVEL SECURITY;
-- backups: after the statement lines they point at (order 30)
INSERT INTO backup_registry (table_name, scope_sql, pk_cols, insert_order, restore) VALUES
  ('coop_bank_statement_line_matches', 'coop_id = $1', ARRAY['id'], 31, true)
ON CONFLICT (table_name) DO NOTHING;
