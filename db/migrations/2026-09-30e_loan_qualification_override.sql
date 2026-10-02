-- Loan qualification override: when a member fails an eligibility check (outstanding dues blocking loan
-- applications, or the requested amount exceeding their package cap), an admin/accountant holding the
-- separately-grantable 'loans'/'override' permission can approve anyway - with a mandatory reason and a
-- mandatory supporting document (the signed approval, board minutes, etc.) kept as backup evidence. Ordinary
-- loan-creation rights ('loans'/'create') do NOT include this - it must be granted on its own. Applied to
-- staging then production, both clean (0 backup-registry gaps/order violations).
INSERT INTO storage.buckets (id, name, public, file_size_limit) VALUES
  ('loan-override-documents', 'loan-override-documents', false, 10485760)
ON CONFLICT (id) DO UPDATE SET public = false;

CREATE TABLE IF NOT EXISTS coop_loan_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id uuid NOT NULL REFERENCES coop_loans(id),
  coop_id text NOT NULL REFERENCES coop_societies(coop_id),
  bypassed_checks jsonb NOT NULL, -- e.g. ["dues_owing", "max_amount_exceeded"] - which qualification gate(s) this override cleared
  reason text NOT NULL,
  approved_by text NOT NULL,
  document_storage_path text NOT NULL,
  document_file_name text NOT NULL,
  document_mime_type text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_coop_loan_overrides_loan ON coop_loan_overrides(loan_id);
CREATE INDEX IF NOT EXISTS idx_coop_loan_overrides_coop ON coop_loan_overrides(coop_id, created_at DESC);
ALTER TABLE coop_loan_overrides ENABLE ROW LEVEL SECURITY;

INSERT INTO backup_registry (table_name, scope_sql, pk_cols, insert_order, restore) VALUES
  ('coop_loan_overrides', 'coop_id = $1', ARRAY['id'], 54, true)
ON CONFLICT (table_name) DO NOTHING;
