-- Run in Supabase SQL Editor to add merchant support

CREATE TABLE IF NOT EXISTS merchants (
  merchant_id     TEXT PRIMARY KEY,
  phone           TEXT NOT NULL,
  owner_name      TEXT NOT NULL,
  business_name   TEXT NOT NULL,
  business_type   TEXT DEFAULT 'General',
  location        TEXT,
  device_id       TEXT,
  status          TEXT DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','PENDING')),
  registered_at   TIMESTAMPTZ DEFAULT NOW(),
  last_login      TIMESTAMPTZ,
  zil_balance_kobo INTEGER DEFAULT 0,
  total_received_kobo INTEGER DEFAULT 0,
  notes           TEXT
);

CREATE INDEX IF NOT EXISTS idx_merchants_phone  ON merchants(phone);
CREATE INDEX IF NOT EXISTS idx_merchants_status ON merchants(status);
