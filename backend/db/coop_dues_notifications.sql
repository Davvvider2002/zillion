-- ============================================================
-- ZILLION — Cooperative Thrift & Loan: dues + notifications
-- Applied directly to production AND staging.
--
-- DUES: deliberately NOT a mutable stored balance — accrual is
-- computed live from calendar periods elapsed since member.activated_at
-- (using AGE()-based calendar math, not a crude day-count approximation
-- — tested locally for both monthly and annual frequencies, including
-- that a brand-new member correctly owes nothing until their first
-- full period completes). Owing = accrued - SUM(coop_dues_transactions).
-- Same "never a figure that could drift" philosophy already used for
-- savings.
--
-- dues_enforcement_rules is a JSONB rules object, not a single flag —
-- starts with just {"block_loan_application": true/false}, but is
-- structured so more conditions can be added later without a schema
-- change or restructuring.
--
-- cash_in_person is a valid coop_dues_transactions.source /
-- coop_savings_transactions.source value (both columns are free TEXT,
-- no schema change needed there) — enforced at the APPLICATION level
-- that recording a cash payment requires a non-empty reference
-- (receipt number, witness name, etc.), since cash has no independent
-- bank record behind it the way a manually-confirmed transfer does.
--
-- NOTIFICATIONS: one row per notification (broadcast or individual),
-- read status tracked per-member via a separate join table — tested
-- locally that one broadcast correctly shows different read/unread
-- state per member, not a single shared state.
-- ============================================================

ALTER TABLE coop_societies ADD COLUMN IF NOT EXISTS dues_amount_kobo BIGINT;
ALTER TABLE coop_societies ADD COLUMN IF NOT EXISTS dues_frequency TEXT DEFAULT 'monthly';
ALTER TABLE coop_societies ADD COLUMN IF NOT EXISTS dues_enforcement_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE coop_societies ADD COLUMN IF NOT EXISTS dues_enforcement_rules JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS coop_dues_transactions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coop_id      TEXT NOT NULL REFERENCES coop_societies(coop_id),
  member_id    UUID NOT NULL REFERENCES coop_members(id),
  amount_kobo  BIGINT NOT NULL CHECK (amount_kobo > 0),
  source       TEXT NOT NULL DEFAULT 'bank_transfer_manual',
  reference    TEXT,
  recorded_by  TEXT NOT NULL,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dues_txn_member ON coop_dues_transactions(member_id);
ALTER TABLE coop_dues_transactions ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS coop_notifications (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coop_id           TEXT NOT NULL REFERENCES coop_societies(coop_id),
  target_type       TEXT NOT NULL DEFAULT 'broadcast',  -- 'broadcast' | 'individual'
  target_member_id  UUID REFERENCES coop_members(id),   -- only set for 'individual'
  title             TEXT NOT NULL,
  body              TEXT NOT NULL,
  sent_by           TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notif_coop ON coop_notifications(coop_id);
ALTER TABLE coop_notifications ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS coop_notification_reads (
  notification_id  UUID NOT NULL REFERENCES coop_notifications(id),
  member_id        UUID NOT NULL REFERENCES coop_members(id),
  read_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (notification_id, member_id)
);
ALTER TABLE coop_notification_reads ENABLE ROW LEVEL SECURITY;
