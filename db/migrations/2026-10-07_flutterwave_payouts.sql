-- Payouts of money Zillion holds on societies' behalf (bank transfers into members' virtual accounts land in ZILLION's
-- Flutterwave balance, not the society's sub-account, so they never appear in the society's own settlements).
-- A payout is PROPOSED automatically, APPROVED by people (maker-checker, two approvers for large amounts, a fresh
-- authenticator code each time), then executed with a unique reference so a retry can never pay twice.
--   PENDING_APPROVAL -> APPROVED -> PROCESSING -> PAID        (or REJECTED / CANCELLED / FAILED)
-- Applied to staging, then production.

CREATE TABLE IF NOT EXISTS coop_flutterwave_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_ref text NOT NULL UNIQUE,                -- also the Flutterwave transfer reference: Flutterwave refuses a duplicate, so a retry cannot pay twice
  coop_id text NOT NULL REFERENCES coop_societies(coop_id),
  status text NOT NULL CHECK (status IN ('PENDING_APPROVAL','APPROVED','PROCESSING','PAID','FAILED','REJECTED','CANCELLED')),
  amount_kobo bigint NOT NULL CHECK (amount_kobo > 0),
  item_count integer NOT NULL,
  approvals_required integer NOT NULL DEFAULT 1,
  dest_bank_code text NOT NULL,                   -- the destination as it was when the payout was prepared; execution refuses if the society's has changed since
  dest_account_number text NOT NULL,
  dest_account_name text,                         -- what the society says the account is called
  resolved_account_name text,                     -- what the BANK says it is called
  name_check text NOT NULL DEFAULT 'UNVERIFIED' CHECK (name_check IN ('MATCH','MISMATCH','UNVERIFIED')),
  settlement_account_code text,                   -- the society's books account debited when it is paid
  requested_by text NOT NULL,
  requested_by_name text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  execution text CHECK (execution IN ('AUTOMATIC','MANUAL')),
  attempts integer NOT NULL DEFAULT 0,
  flw_transfer_id text,
  flw_status text,
  transfer_fee_kobo bigint,
  failure_reason text,
  needs_verification boolean NOT NULL DEFAULT false,   -- outcome of a transfer attempt is unknown: do NOT retry until someone checks with Flutterwave
  paid_at timestamptz,
  paid_reference text,
  society_ledger_row_id uuid,
  zillion_journal_entry_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- at most ONE live payout per society at a time: the database, not the application, prevents two overlapping payouts
CREATE UNIQUE INDEX IF NOT EXISTS uq_flw_payout_active ON coop_flutterwave_payouts (coop_id) WHERE status IN ('PENDING_APPROVAL','APPROVED','PROCESSING');
CREATE INDEX IF NOT EXISTS idx_flw_payout_status ON coop_flutterwave_payouts (status, created_at);
ALTER TABLE coop_flutterwave_payouts ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS coop_flutterwave_payout_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_id uuid NOT NULL REFERENCES coop_flutterwave_payouts(id),
  coop_id text NOT NULL,
  event text NOT NULL,                            -- PREPARED, APPROVED, REJECTED, CANCELLED, EXECUTION_STARTED, EXECUTION_FAILED, SENT, PAID, FAILED, ...
  actor text NOT NULL,                            -- admin user id, or system:...
  actor_name text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_flw_payout_events ON coop_flutterwave_payout_events (payout_id, created_at);
ALTER TABLE coop_flutterwave_payout_events ENABLE ROW LEVEL SECURITY;

-- which payout (if any) a ledger row is reserved for
ALTER TABLE coop_flutterwave_ledger ADD COLUMN IF NOT EXISTS payout_id uuid REFERENCES coop_flutterwave_payouts(id);
CREATE INDEX IF NOT EXISTS idx_flw_ledger_payout ON coop_flutterwave_ledger (payout_id) WHERE payout_id IS NOT NULL;

-- Zillion's own books: the liability to societies, and the cost of transfers
INSERT INTO zillion_chart_of_accounts (account_code, account_name, account_type, currency, is_system)
SELECT v.code, v.name, v.type, 'NGN', true FROM (VALUES ('2000','Owed to Societies (collected on their behalf)','LIABILITY'), ('5100','Transfer Fees','EXPENSE')) v(code, name, type)
WHERE NOT EXISTS (SELECT 1 FROM zillion_chart_of_accounts z WHERE z.account_code = v.code);

-- backups: payouts after the societies they belong to and BEFORE the ledger rows that point at them; events after payouts
INSERT INTO backup_registry (table_name, scope_sql, pk_cols, insert_order, restore) VALUES
  ('coop_flutterwave_payouts', 'coop_id = $1', ARRAY['id'], 54, true),
  ('coop_flutterwave_payout_events', 'coop_id = $1', ARRAY['id'], 56, true)
ON CONFLICT (table_name) DO NOTHING;
