-- Finishing the Ajo build: in-app notifications (contribution due/missed, upcoming/completed payouts) and
-- member reliability scoring. Both keyed by zillion_id, not coop_id — an Ajo scheme has no coop_id (most never
-- become a formal coop; converted_to_coop_id is the exception), so these are parallel to, not reuses of,
-- coop_notifications. Applied to staging then production, both clean (0 backup-registry gaps/order violations).
CREATE TABLE IF NOT EXISTS ajo_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scheme_id uuid REFERENCES ajo_schemes(id),
  target_type text NOT NULL CHECK (target_type IN ('scheme_broadcast','individual')),
  target_zillion_id text,
  type text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  dedupe_key text UNIQUE,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ajo_notifications_scheme ON ajo_notifications(scheme_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ajo_notifications_target ON ajo_notifications(target_zillion_id, created_at DESC);
ALTER TABLE ajo_notifications ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS ajo_notification_reads (
  notification_id uuid NOT NULL REFERENCES ajo_notifications(id),
  zillion_id text NOT NULL,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, zillion_id)
);
ALTER TABLE ajo_notification_reads ENABLE ROW LEVEL SECURITY;

-- Recomputed nightly (see lib/ajoReliability.js) — a derived figure, not a source-of-truth ledger fact, so it's
-- fine for it to lag by up to one nightly cycle rather than being computed live on every request.
ALTER TABLE ajo_scheme_members
  ADD COLUMN IF NOT EXISTS reliability_score numeric(5,2),
  ADD COLUMN IF NOT EXISTS reliability_updated_at timestamptz;

INSERT INTO backup_registry_excluded (table_name, reason) VALUES
 ('ajo_notifications', 'Ajo module — no coop_id, keyed by zillion_id; platform backup only, same as ajo_schemes.'),
 ('ajo_notification_reads', 'Ajo module — see ajo_notifications.')
ON CONFLICT (table_name) DO NOTHING;
