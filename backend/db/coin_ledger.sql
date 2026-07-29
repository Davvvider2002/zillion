-- ============================================================
-- ZILLION — Immutable Coin Movement Ledger
-- Run in Supabase SQL Editor. Safe to re-run (idempotent).
--
-- WHY THIS EXISTS:
--   coins.holder_hash and coins.status are mutated in place on every
--   transfer (P2P send, agent issuance, merchant redemption, etc).
--   That makes `coins` a correct CURRENT-STATE table but a broken
--   HISTORY table: the moment a coin moves to a new holder, the
--   previous holder's "I received this coin" event becomes invisible
--   to any query keyed on holder_hash. This is what caused the admin
--   Ledger view and the Customers list to disagree — the ledger was
--   reconstructing history from a table that had already overwritten it.
--
--   This migration adds an APPEND-ONLY audit table plus a trigger that
--   fires on every INSERT/UPDATE to `coins`, so no future code path —
--   however it's written, today or in six months — can accidentally
--   drop history again. The `coins` table stays exactly as-is and keeps
--   working as the live balance source; this just adds a permanent,
--   tamper-evident record of every state change alongside it.
-- ============================================================

-- ── LEDGER TABLE (append-only) ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS coin_ledger (
  entry_id          BIGSERIAL     PRIMARY KEY,
  coin_id           TEXT          NOT NULL,
  amount            BIGINT,
  event_type        TEXT          NOT NULL,   -- 'MINT' | 'TRANSFER' | 'STATUS_CHANGE' | 'MINT_BACKFILL'
  prev_holder_hash  TEXT,
  new_holder_hash   TEXT,
  prev_status       TEXT,
  new_status        TEXT,
  changed_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_coin_ledger_coin_id      ON coin_ledger (coin_id);
CREATE INDEX IF NOT EXISTS idx_coin_ledger_prev_holder  ON coin_ledger (prev_holder_hash);
CREATE INDEX IF NOT EXISTS idx_coin_ledger_new_holder   ON coin_ledger (new_holder_hash);
CREATE INDEX IF NOT EXISTS idx_coin_ledger_changed_at   ON coin_ledger (changed_at);

-- Immutability — same pattern already used for admin_audit_log.
-- Blocks UPDATE/DELETE entirely; the only way data enters this table is
-- via the trigger below (or the one-time backfill at the bottom).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_rules WHERE rulename = 'no_update_coin_ledger' AND tablename = 'coin_ledger'
  ) THEN
    EXECUTE 'CREATE RULE no_update_coin_ledger AS ON UPDATE TO coin_ledger DO INSTEAD NOTHING';
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_rules WHERE rulename = 'no_delete_coin_ledger' AND tablename = 'coin_ledger'
  ) THEN
    EXECUTE 'CREATE RULE no_delete_coin_ledger AS ON DELETE TO coin_ledger DO INSTEAD NOTHING';
  END IF;
END $$;

-- ── TRIGGER: fires on every coins INSERT/UPDATE ──────────────────────────
-- Structural guarantee: this does not depend on any Netlify function
-- remembering to log a movement. It fires at the database level no matter
-- which function (sync.js, issue.js, redeem.js, coins-split.js, admin
-- tools, future code, manual SQL fixes) touches the coins table.

CREATE OR REPLACE FUNCTION log_coin_movement() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO coin_ledger (coin_id, amount, event_type, prev_holder_hash, new_holder_hash, prev_status, new_status, changed_at)
    VALUES (NEW.coin_id, NEW.amount, 'MINT', NULL, NEW.holder_hash, NULL, NEW.status, NOW());
    RETURN NEW;

  ELSIF TG_OP = 'UPDATE' THEN
    IF (NEW.holder_hash IS DISTINCT FROM OLD.holder_hash)
       OR (NEW.status IS DISTINCT FROM OLD.status) THEN
      INSERT INTO coin_ledger (coin_id, amount, event_type, prev_holder_hash, new_holder_hash, prev_status, new_status, changed_at)
      VALUES (
        NEW.coin_id,
        NEW.amount,
        CASE WHEN NEW.holder_hash IS DISTINCT FROM OLD.holder_hash THEN 'TRANSFER' ELSE 'STATUS_CHANGE' END,
        OLD.holder_hash, NEW.holder_hash,
        OLD.status,      NEW.status,
        NOW()
      );
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_coin_movement ON coins;
CREATE TRIGGER trg_coin_movement
  AFTER INSERT OR UPDATE ON coins
  FOR EACH ROW EXECUTE FUNCTION log_coin_movement();

-- ── ONE-TIME BACKFILL ─────────────────────────────────────────────────────
-- We can't reconstruct history from before this migration (the previous
-- holders were already overwritten) — but every coin currently in the
-- table gets a baseline MINT_BACKFILL entry at its current holder/status,
-- so the ledger has solid ground to build on going forward. History from
-- this point on is complete and permanent.

INSERT INTO coin_ledger (coin_id, amount, event_type, prev_holder_hash, new_holder_hash, prev_status, new_status, changed_at)
SELECT
  c.coin_id, c.amount, 'MINT_BACKFILL', NULL, c.holder_hash, NULL, c.status,
  COALESCE(c.issued_at, c.created_at, NOW())
FROM coins c
WHERE NOT EXISTS (SELECT 1 FROM coin_ledger cl WHERE cl.coin_id = c.coin_id);

-- ── RECONCILIATION HELPER VIEW ────────────────────────────────────────────
-- Per holder_hash, the running balance the ledger implies right now.
-- Compare against live `coins` balance (SUM(amount) WHERE status='HELD')
-- in admin-reconcile-all.js — any drift means something wrote to `coins`
-- outside the trigger's view (should be impossible) or a bug elsewhere.

CREATE OR REPLACE VIEW coin_ledger_holder_balance AS
SELECT
  new_holder_hash AS holder_hash,
  SUM(CASE WHEN new_status = 'HELD' THEN amount ELSE 0 END)
    - SUM(CASE WHEN prev_status = 'HELD' AND new_status <> 'HELD' THEN amount ELSE 0 END) AS implied_held_kobo,
  COUNT(*) AS movement_count,
  MAX(changed_at) AS last_movement
FROM coin_ledger
WHERE new_holder_hash IS NOT NULL
GROUP BY new_holder_hash;

-- ============================================================
-- POST-MIGRATION CHECKLIST:
-- 1. Run in Supabase SQL Editor.
-- 2. Verify: SELECT COUNT(*) FROM coin_ledger; should equal (or exceed,
--    once live traffic resumes) SELECT COUNT(*) FROM coins;
-- 3. admin-ledger.js now reads from coin_ledger first for customer
--    statements when rows exist, falling back to the coins+transactions
--    method only for edge cases the migration didn't cover.
-- ============================================================
