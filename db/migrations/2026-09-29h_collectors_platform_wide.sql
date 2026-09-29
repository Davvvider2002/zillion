-- Correction: collectors work for Zillion Ajo platform-wide, not for an individual Ajo group admin. The
-- recruitment link/QR/fee is a single platform-wide thing Zillion Admin controls, not something each Ajo
-- admin generates for themselves — and it lives in Zillion Admin, never in the wallet/Ajo app.
-- Near-zero real data existed under the old per-admin scoping (0 recruitment settings rows), so this is a
-- clean restructure, not a data migration. Applied to staging then production, both clean (0 backup-registry
-- gaps/order violations).

-- Commission is now a property of the collector (set by Zillion Admin), not of each scheme the group admin
-- configures at creation — matches "Ajo admin can only select from the list of collectors available."
ALTER TABLE ajo_collector_profiles
  ADD COLUMN IF NOT EXISTS commission_type text NOT NULL DEFAULT 'fixed',
  ADD COLUMN IF NOT EXISTS commission_value integer NOT NULL DEFAULT 0;
ALTER TABLE ajo_collector_profiles ADD CONSTRAINT ajo_collector_profiles_commission_type_check CHECK (commission_type IN ('fixed', 'percentage'));
ALTER TABLE ajo_collector_profiles ADD CONSTRAINT ajo_collector_profiles_commission_value_check CHECK (commission_value >= 0 AND (commission_type != 'percentage' OR commission_value <= 10000));

-- Singleton table for the one platform-wide collector joining fee — boolean PK with CHECK(id) enforces
-- exactly one row can ever exist, so there's no "which admin's fee" ambiguity to resolve at join time.
CREATE TABLE IF NOT EXISTS ajo_collector_platform_settings (
  id boolean PRIMARY KEY DEFAULT true,
  joining_fee_kobo integer NOT NULL CHECK (joining_fee_kobo > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  CONSTRAINT ajo_collector_platform_settings_singleton CHECK (id)
);
ALTER TABLE ajo_collector_platform_settings ENABLE ROW LEVEL SECURITY;

-- The old per-admin table is no longer used at all (0 rows) — dropped rather than left as dead schema.
DROP TABLE IF EXISTS ajo_collector_recruitment_settings;

-- No longer set at scheme creation by the group admin — a scheme's collector compensation now comes from
-- the collector's own commission_type/commission_value above.
ALTER TABLE ajo_schemes DROP COLUMN IF EXISTS collector_compensation_type;
ALTER TABLE ajo_schemes DROP COLUMN IF EXISTS collector_compensation_value;

-- No longer populated (the join flow is admin-agnostic now) — left nullable rather than dropped, in case a
-- future audit trail wants it.
ALTER TABLE ajo_collector_join_applications ALTER COLUMN recruiting_admin_zillion_id DROP NOT NULL;

DELETE FROM backup_registry_excluded WHERE table_name = 'ajo_collector_recruitment_settings';
INSERT INTO backup_registry_excluded (table_name, reason) VALUES
  ('ajo_collector_platform_settings', 'Platform-wide singleton config, not per-society data.')
ON CONFLICT (table_name) DO NOTHING;
