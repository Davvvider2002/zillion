-- Go-live catch-up, phase 1 (foundations). Idempotent: safe to re-run.
-- A society that starts on Zillion part way through its financial year imports what already happened, with real
-- dates, in a "migration batch". This migration adds the batch table, tags every record a batch can create, and lets
-- a member carry a past join date and an exited status. Nothing here changes how live records behave.

CREATE TABLE IF NOT EXISTS coop_migration_batches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coop_id       text NOT NULL REFERENCES coop_societies(coop_id),
  label         text NOT NULL,
  kind          text NOT NULL DEFAULT 'go_live',
  fy_start      date NOT NULL,
  cutover_date  date NOT NULL,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','locked','void')),
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  locked_at     timestamptz,
  locked_by     text,
  approved_by   text[],
  note          text,
  CHECK (cutover_date >= fy_start)
);
ALTER TABLE coop_migration_batches ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_coop_migration_batches_coop ON coop_migration_batches (coop_id, status);
-- One open batch per society at a time: two drafts would race over the same year.
CREATE UNIQUE INDEX IF NOT EXISTS idx_coop_migration_batches_one_draft ON coop_migration_batches (coop_id) WHERE status = 'draft';

-- Tag every table a batch writes into, so a draft batch can be replaced cleanly and every imported line is traceable.
ALTER TABLE coop_members              ADD COLUMN IF NOT EXISTS migration_batch_id uuid REFERENCES coop_migration_batches(id);
ALTER TABLE coop_savings_transactions ADD COLUMN IF NOT EXISTS migration_batch_id uuid REFERENCES coop_migration_batches(id);
ALTER TABLE coop_dues_transactions    ADD COLUMN IF NOT EXISTS migration_batch_id uuid REFERENCES coop_migration_batches(id);
ALTER TABLE coop_share_transactions   ADD COLUMN IF NOT EXISTS migration_batch_id uuid REFERENCES coop_migration_batches(id);
ALTER TABLE coop_loans                ADD COLUMN IF NOT EXISTS migration_batch_id uuid REFERENCES coop_migration_batches(id);
ALTER TABLE coop_loan_repayments      ADD COLUMN IF NOT EXISTS migration_batch_id uuid REFERENCES coop_migration_batches(id);
ALTER TABLE coop_journal_entries      ADD COLUMN IF NOT EXISTS migration_batch_id uuid REFERENCES coop_migration_batches(id);

CREATE INDEX IF NOT EXISTS idx_coop_members_mig_batch      ON coop_members (migration_batch_id)              WHERE migration_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_coop_savings_tx_mig_batch   ON coop_savings_transactions (migration_batch_id) WHERE migration_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_coop_dues_tx_mig_batch      ON coop_dues_transactions (migration_batch_id)    WHERE migration_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_coop_share_tx_mig_batch     ON coop_share_transactions (migration_batch_id)   WHERE migration_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_coop_loans_mig_batch        ON coop_loans (migration_batch_id)                WHERE migration_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_coop_loan_repay_mig_batch   ON coop_loan_repayments (migration_batch_id)      WHERE migration_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_coop_journal_mig_batch      ON coop_journal_entries (migration_batch_id)      WHERE migration_batch_id IS NOT NULL;

-- A member who left earlier in the year stays on the register as EXITED so their entitlement survives.
ALTER TABLE coop_members ADD COLUMN IF NOT EXISTS exited_at   timestamptz;
ALTER TABLE coop_members ADD COLUMN IF NOT EXISTS exit_reason text;

-- If coop_members.status is guarded by a CHECK list, it must allow EXITED. Fail loudly rather than guess the list.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
            WHERE conrelid = 'coop_members'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%status%'
              AND pg_get_constraintdef(oid) NOT ILIKE '%kyc_status%' LOOP
    IF c.def NOT ILIKE '%EXITED%' THEN
      RAISE EXCEPTION 'coop_members constraint % restricts status and does not allow EXITED (%). Extend it by hand, then re-run.', c.conname, c.def;
    END IF;
  END LOOP;
END $$;

-- Backup and restore: the batch table is society data and is a parent of the tables above, so it restores first.
INSERT INTO backup_registry (table_name, scope_sql, pk_cols, insert_order, restore, note)
VALUES ('coop_migration_batches', 'coop_id = $1', '{id}', 5, true, 'Go-live catch-up batches. Parent of the migration_batch_id columns on members, ledgers and journals.')
ON CONFLICT (table_name) DO UPDATE SET scope_sql = EXCLUDED.scope_sql, pk_cols = EXCLUDED.pk_cols, insert_order = EXCLUDED.insert_order, restore = EXCLUDED.restore, note = EXCLUDED.note;
