-- Run this in Supabase SQL Editor to add QR claim support

CREATE TABLE IF NOT EXISTS claim_bundles (
  claim_id     TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  bundle_data  JSONB NOT NULL,
  agent_id     TEXT NOT NULL,
  amount_kobo  INTEGER NOT NULL,
  coin_count   INTEGER NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  expires_at   TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '15 minutes'),
  claimed_at   TIMESTAMPTZ,
  claimed_by   TEXT,
  status       TEXT DEFAULT 'PENDING' CHECK (status IN ('PENDING','CLAIMED','EXPIRED'))
);

-- Auto-expire old claims
CREATE INDEX IF NOT EXISTS idx_claim_expires ON claim_bundles(expires_at);
CREATE INDEX IF NOT EXISTS idx_claim_status  ON claim_bundles(status);

-- Cleanup function (run periodically or on each fetch)
CREATE OR REPLACE FUNCTION expire_claims() RETURNS void AS $$
  UPDATE claim_bundles 
  SET status = 'EXPIRED' 
  WHERE expires_at < NOW() AND status = 'PENDING';
$$ LANGUAGE SQL;

