-- ============================================================
-- ZILLION — Rate Limiting
-- Applied to production this session but never committed until now.
-- Safe to re-run (idempotent).
-- ============================================================

CREATE TABLE IF NOT EXISTS rate_limit_attempts (
  rate_key      TEXT          PRIMARY KEY,
  attempt_count INTEGER       NOT NULL DEFAULT 0,
  window_start  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  locked_until  TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_locked ON rate_limit_attempts (locked_until);

ALTER TABLE rate_limit_attempts ENABLE ROW LEVEL SECURITY;
