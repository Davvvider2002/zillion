-- State of the public demo cooperative (see backend/lib/coopDemo.js). One row, id = 1.
-- No coop_id column on purpose: this is platform bookkeeping, not society data, so the backup coverage guard ignores it.
CREATE TABLE IF NOT EXISTS demo_society_state (
  id                 integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  society_coop_id    text,
  merchant_id        text,
  baseline_backup_id uuid,
  status             text NOT NULL DEFAULT 'not_built' CHECK (status IN ('not_built', 'building', 'ready', 'failed')),
  status_detail      text,
  last_error         text,
  build_log          text,
  reset_every_days   integer NOT NULL DEFAULT 3 CHECK (reset_every_days BETWEEN 1 AND 30),
  built_at           timestamptz,
  last_reset_at      timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE demo_society_state ENABLE ROW LEVEL SECURITY;
