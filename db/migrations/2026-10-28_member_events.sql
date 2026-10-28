-- Member event log: one row for everything that happens on a member's account (money in or out, loans, dividends, profile and
-- status changes), with a ready-to-send message. The in-app feed reads the linked coop_notifications row. A later step adds the
-- WhatsApp outbox, which works through the rows still marked 'pending'.
CREATE TABLE IF NOT EXISTS coop_member_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coop_id          text NOT NULL REFERENCES coop_societies(coop_id),
  member_id        uuid NOT NULL,
  kind             text NOT NULL,
  title            text NOT NULL,
  message          text NOT NULL,
  amount_kobo      bigint,
  reference        text,
  actor            text NOT NULL DEFAULT 'system',
  dedupe_key       text,
  member_phone     text,
  notification_id  uuid,
  whatsapp_status  text NOT NULL DEFAULT 'pending' CHECK (whatsapp_status IN ('pending', 'sent', 'skipped')),
  whatsapp_sent_at timestamptz,
  whatsapp_sent_by text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_coop_member_events_dedupe ON coop_member_events(coop_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_coop_member_events_member ON coop_member_events(member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_coop_member_events_outbox ON coop_member_events(coop_id, whatsapp_status, created_at);
ALTER TABLE coop_member_events ENABLE ROW LEVEL SECURITY;

INSERT INTO backup_registry (table_name, scope_sql, pk_cols, insert_order, restore, note)
VALUES ('coop_member_events', 'coop_id = $1', '{id}', 31, true, 'Member event log and WhatsApp outbox state. Follows coop_members and coop_notifications.')
ON CONFLICT (table_name) DO UPDATE SET scope_sql = EXCLUDED.scope_sql, pk_cols = EXCLUDED.pk_cols, insert_order = EXCLUDED.insert_order, restore = EXCLUDED.restore, note = EXCLUDED.note;
