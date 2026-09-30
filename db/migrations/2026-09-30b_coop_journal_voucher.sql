-- Journal Voucher for splitting a member's lump-sum payment across categories (savings, dues, loan repayment,
-- shares) in one action — each leg goes through the SAME proven recording logic a standalone payment would
-- (updates the member's actual balance, not just a raw GL posting), so a ₦100,000 bank transfer split into
-- ₦50,000 savings / ₦20,000 dues / ₦30,000 loan repayment produces exactly what three separate payments
-- would have, just under one voucher and one reference. Applied to staging then production, both clean
-- (0 backup-registry gaps/order violations).
CREATE TABLE IF NOT EXISTS coop_journal_vouchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coop_id text NOT NULL REFERENCES coop_societies(coop_id),
  member_id uuid NOT NULL REFERENCES coop_members(id),
  total_amount_kobo bigint NOT NULL CHECK (total_amount_kobo > 0),
  source text NOT NULL,
  reference text,
  debit_account_id uuid REFERENCES coop_chart_of_accounts(id),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_coop_journal_vouchers_coop ON coop_journal_vouchers(coop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_coop_journal_vouchers_member ON coop_journal_vouchers(member_id);
ALTER TABLE coop_journal_vouchers ENABLE ROW LEVEL SECURITY;

-- Has its own coop_id (denormalized from its voucher), matching how coop_journal_entry_lines is already
-- registered — not excluded, since a voucher without its legs restored would be an incomplete audit trail.
CREATE TABLE IF NOT EXISTS coop_journal_voucher_legs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_id uuid NOT NULL REFERENCES coop_journal_vouchers(id),
  coop_id text NOT NULL REFERENCES coop_societies(coop_id),
  leg_type text NOT NULL CHECK (leg_type IN ('savings', 'dues', 'loan_repayment', 'shares', 'investment')),
  amount_kobo bigint NOT NULL CHECK (amount_kobo > 0),
  target_id uuid,
  resulting_table text NOT NULL,
  resulting_transaction_id uuid NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_coop_journal_voucher_legs_voucher ON coop_journal_voucher_legs(voucher_id);
CREATE INDEX IF NOT EXISTS idx_coop_journal_voucher_legs_coop ON coop_journal_voucher_legs(coop_id);
ALTER TABLE coop_journal_voucher_legs ENABLE ROW LEVEL SECURITY;

INSERT INTO backup_registry (table_name, scope_sql, pk_cols, insert_order, restore) VALUES
  ('coop_journal_vouchers', 'coop_id = $1', ARRAY['id'], 52, true),
  ('coop_journal_voucher_legs', 'coop_id = $1', ARRAY['id'], 53, true)
ON CONFLICT (table_name) DO NOTHING;
