-- Coop Agent recruitment: self-service public application (no fee, unlike collectors), reviewed by Zillion
-- Admin, outcome emailed. Replaces the "type in someone's zillion_id" flow — most applicants won't have one
-- yet (they're a business prospect, not necessarily an existing wallet user), so a zillion_id is resolved
-- from their phone only at approval time, same pattern already used for collectors/coop signups.
-- Applied to staging then production, both clean (0 backup-registry gaps/order violations).
CREATE TABLE IF NOT EXISTS coop_agent_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  phone text NOT NULL,
  email text NOT NULL,
  address text,
  office_location text,
  staff_count integer,
  qualifications text,
  saas_experience text,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by text,
  rejection_reason text,
  resulting_agent_id uuid REFERENCES coop_agents(id)
);
CREATE INDEX IF NOT EXISTS idx_coop_agent_applications_status ON coop_agent_applications(status, submitted_at);
ALTER TABLE coop_agent_applications ENABLE ROW LEVEL SECURITY;

INSERT INTO backup_registry_excluded (table_name, reason) VALUES
  ('coop_agent_applications', 'Platform-wide recruitment pipeline, not per-society data — same treatment as coop_agents.')
ON CONFLICT (table_name) DO NOTHING;
