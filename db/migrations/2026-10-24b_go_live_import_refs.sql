-- Go-live catch-up, phase 2 (importers). Idempotent: safe to re-run.
-- import_ref: the society's own loan reference from its old records, so repayment rows can find their loan.
-- migration_dataset: which sheet created a journal entry, so one sheet can be replaced without touching the others.
ALTER TABLE coop_loans           ADD COLUMN IF NOT EXISTS import_ref text;
ALTER TABLE coop_journal_entries ADD COLUMN IF NOT EXISTS migration_dataset text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_coop_loans_import_ref ON coop_loans (coop_id, lower(import_ref)) WHERE import_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_coop_journal_mig_dataset ON coop_journal_entries (migration_batch_id, migration_dataset) WHERE migration_batch_id IS NOT NULL;
