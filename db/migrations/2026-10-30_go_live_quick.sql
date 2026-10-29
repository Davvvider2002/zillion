-- Go-live "Quick start": one position as at the cutover date instead of dated history.
-- mode: 'detailed' (the original sheets) or 'quick'. quick_ledger keeps the society's own trial balance lines so the opening
-- entry can be rebuilt whenever the member or loan sheets change.
ALTER TABLE coop_migration_batches ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'detailed' CHECK (mode IN ('detailed', 'quick'));
ALTER TABLE coop_migration_batches ADD COLUMN IF NOT EXISTS quick_ledger jsonb;
