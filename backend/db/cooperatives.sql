-- ============================================================
-- ZILLION — Cooperatives (farmer group aggregated view)
-- Applied directly to production. A cooperative is a group of
-- farmers selling together; members are existing wallet users,
-- linked by holder_hash (same identity used everywhere else for
-- "whose money this is"). Admin-managed: members are assigned by
-- an admin, not self-enrolled.
-- ============================================================

CREATE TABLE IF NOT EXISTS cooperatives (
  coop_id       TEXT PRIMARY KEY DEFAULT ('COOP-' || substr(md5(random()::text), 1, 8)),
  name          TEXT NOT NULL,
  location      TEXT,
  contact_name  TEXT,
  contact_phone TEXT,
  status        TEXT NOT NULL DEFAULT 'ACTIVE',
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cooperative_members (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coop_id       TEXT NOT NULL REFERENCES cooperatives(coop_id),
  holder_hash   TEXT NOT NULL,
  member_name   TEXT,
  member_phone  TEXT,
  added_by      TEXT,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(coop_id, holder_hash)
);

CREATE INDEX IF NOT EXISTS idx_coop_members_coop   ON cooperative_members(coop_id);
CREATE INDEX IF NOT EXISTS idx_coop_members_holder ON cooperative_members(holder_hash);
CREATE INDEX IF NOT EXISTS idx_coop_status         ON cooperatives(status);

ALTER TABLE cooperatives ENABLE ROW LEVEL SECURITY;
ALTER TABLE cooperative_members ENABLE ROW LEVEL SECURITY;
