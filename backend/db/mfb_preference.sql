-- ============================================================
-- ZILLION — MFB Preferred-Bank Feature
-- Applied to production this session but never committed until now.
-- Safe to re-run (idempotent).
-- ============================================================

ALTER TABLE devices ADD COLUMN IF NOT EXISTS preferred_mfb_id TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS preferred_mfb_updated_at TIMESTAMPTZ;

ALTER TABLE merchants ADD COLUMN IF NOT EXISTS preferred_mfb_id TEXT;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS preferred_mfb_updated_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS agent_mfb_change_requests (
  request_id          TEXT          PRIMARY KEY DEFAULT ('MFBREQ-' || substr(md5(random()::text), 1, 12)),
  agent_id            TEXT          NOT NULL,
  current_mfb_id      TEXT,
  current_mfb_name    TEXT,
  requested_mfb_id    TEXT          NOT NULL,
  requested_mfb_name  TEXT          NOT NULL,
  status              TEXT          NOT NULL DEFAULT 'PENDING',
  reason              TEXT,
  requested_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  reviewed_at         TIMESTAMPTZ,
  reviewed_by         TEXT,
  review_notes        TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_mfb_requests_agent  ON agent_mfb_change_requests (agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_mfb_requests_status ON agent_mfb_change_requests (status);

ALTER TABLE agent_mfb_change_requests ENABLE ROW LEVEL SECURITY;
