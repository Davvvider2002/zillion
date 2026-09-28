-- Coop-level NIN/KYC: member fields, a metered per-verification ledger, and a monthly invoice a society pays for
-- however many verifications it ran that month. Applied to staging (real-data smoke test, rolled back) then
-- production. Idempotent: safe to re-run.

ALTER TABLE coop_members
  ADD COLUMN IF NOT EXISTS nin_hash text,
  ADD COLUMN IF NOT EXISTS nin_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS kyc_status text NOT NULL DEFAULT 'NOT_SUBMITTED';
ALTER TABLE coop_members DROP CONSTRAINT IF EXISTS coop_members_kyc_status_check;
ALTER TABLE coop_members ADD CONSTRAINT coop_members_kyc_status_check CHECK (kyc_status IN ('NOT_SUBMITTED','VERIFIED'));

-- Platform-wide price per verification (what Zillion charges a society), set by Zillion Admin. Single row.
CREATE TABLE IF NOT EXISTS coop_kyc_pricing (
  id text PRIMARY KEY DEFAULT 'default',
  price_kobo bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);
INSERT INTO coop_kyc_pricing (id, price_kobo) VALUES ('default', 0) ON CONFLICT (id) DO NOTHING;
ALTER TABLE coop_kyc_pricing ENABLE ROW LEVEL SECURITY;

-- One row per society per calendar month. 'accruing' while the month is in progress; the nightly job finalizes
-- the previous month into 'pending_payment' with a due date; becomes 'paid' once the society pays.
CREATE TABLE IF NOT EXISTS coop_kyc_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coop_id text NOT NULL REFERENCES coop_societies(coop_id),
  period_start date NOT NULL,
  period_end date NOT NULL,
  verification_count int NOT NULL DEFAULT 0,
  total_kobo bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'accruing' CHECK (status IN ('accruing','pending_payment','paid')),
  due_at timestamptz,
  tx_ref text,
  flw_transaction_id text,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (coop_id, period_start)
);
CREATE INDEX IF NOT EXISTS idx_coop_kyc_invoices_coop ON coop_kyc_invoices (coop_id, period_start DESC);
ALTER TABLE coop_kyc_invoices ENABLE ROW LEVEL SECURITY;

-- Immutable ledger: every call made to Dojah, matched or not (billed either way, per the agreed policy), what
-- Zillion paid Dojah for it, and what the society is charged. invoice_id is set once the attempt is rolled into
-- that month's invoice.
CREATE TABLE IF NOT EXISTS coop_kyc_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coop_id text NOT NULL REFERENCES coop_societies(coop_id),
  member_id uuid NOT NULL REFERENCES coop_members(id),
  provider text NOT NULL DEFAULT 'dojah',
  nin_hash text NOT NULL,
  matched boolean NOT NULL,
  dojah_reference text,
  dojah_cost_kobo bigint NOT NULL DEFAULT 0,
  charged_kobo bigint NOT NULL DEFAULT 0,
  invoice_id uuid REFERENCES coop_kyc_invoices(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);
CREATE INDEX IF NOT EXISTS idx_coop_kyc_verifications_coop ON coop_kyc_verifications (coop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_coop_kyc_verifications_member ON coop_kyc_verifications (member_id, created_at DESC);
ALTER TABLE coop_kyc_verifications ENABLE ROW LEVEL SECURITY;

-- Backup registry: both new coop-scoped tables are restorable society data. coop_kyc_pricing is platform config,
-- not society data, so it is excluded (like coop_addon_modules).
INSERT INTO backup_registry (table_name, scope_sql, pk_cols, insert_order, restore, note) VALUES
 ('coop_kyc_invoices', 'coop_id = $1', '{id}', 10, true, NULL),
 ('coop_kyc_verifications', 'coop_id = $1', '{id}', 20, true, NULL)
ON CONFLICT (table_name) DO UPDATE SET scope_sql = EXCLUDED.scope_sql, pk_cols = EXCLUDED.pk_cols, insert_order = EXCLUDED.insert_order, restore = EXCLUDED.restore;

INSERT INTO backup_registry_excluded (table_name, reason) VALUES
 ('coop_kyc_pricing', 'Platform-wide pricing config (what Zillion charges per verification), not per-society data.')
ON CONFLICT (table_name) DO NOTHING;
