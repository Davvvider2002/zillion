-- ============================================================
-- ZILLION — System Alerts (monitoring infrastructure)
-- Applied to production this session but never committed until now.
-- Safe to re-run (idempotent).
-- ============================================================

CREATE TABLE IF NOT EXISTS system_alerts (
  alert_id      BIGSERIAL     PRIMARY KEY,
  severity      TEXT          NOT NULL DEFAULT 'INFO',
  source        TEXT          NOT NULL,
  message       TEXT          NOT NULL,
  context       JSONB,
  resolved      BOOLEAN       NOT NULL DEFAULT FALSE,
  resolved_at   TIMESTAMPTZ,
  resolved_by   TEXT,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_system_alerts_unresolved ON system_alerts (resolved, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_alerts_severity   ON system_alerts (severity);

ALTER TABLE system_alerts ENABLE ROW LEVEL SECURITY;
