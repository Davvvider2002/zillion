-- Go-live phase 4: a per-batch trail of who did what (sheet loads, approvals, lock), shown in the portal and kept with the society's data.
CREATE TABLE IF NOT EXISTS coop_migration_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id    uuid NOT NULL REFERENCES coop_migration_batches(id) ON DELETE CASCADE,
  coop_id     text NOT NULL,
  action      text NOT NULL,
  actor       text NOT NULL,
  actor_name  text,
  detail      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_coop_migration_events_batch ON coop_migration_events(batch_id, created_at);
ALTER TABLE coop_migration_events ENABLE ROW LEVEL SECURITY;

INSERT INTO backup_registry (table_name, scope_sql, pk_cols, insert_order, restore, note)
VALUES ('coop_migration_events', 'coop_id = $1', '{id}', 7, true, 'Go-live audit trail. Follows coop_migration_batches.')
ON CONFLICT (table_name) DO UPDATE SET scope_sql = EXCLUDED.scope_sql, pk_cols = EXCLUDED.pk_cols, insert_order = EXCLUDED.insert_order, restore = EXCLUDED.restore, note = EXCLUDED.note;
