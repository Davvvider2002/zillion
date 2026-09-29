-- Two-tier agent commission: a recruiting agent earns an override on their sub-agents' own commission, capped
-- at two tiers deep (enforced in admin-ajo-agents.js, not the database — a parent must itself have no parent).
-- Override is additive, not deducted from the sub-agent's own commission: the sub-agent's earnings row is
-- untouched, the parent's override is a separate row, so nobody's visible earnings shrink because of who
-- recruited them. Applied to staging then production, both confirmed.
ALTER TABLE ajo_agents
  ADD COLUMN IF NOT EXISTS parent_agent_id uuid REFERENCES ajo_agents(id),
  ADD COLUMN IF NOT EXISTS tier2_override_bps integer;
ALTER TABLE ajo_agents ADD CONSTRAINT ajo_agents_tier2_override_bps_check CHECK (tier2_override_bps IS NULL OR (tier2_override_bps > 0 AND tier2_override_bps <= 10000));
CREATE INDEX IF NOT EXISTS idx_ajo_agents_parent ON ajo_agents(parent_agent_id);

ALTER TABLE ajo_agent_earnings
  ADD COLUMN IF NOT EXISTS tier smallint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS downline_agent_id uuid REFERENCES ajo_agents(id);
ALTER TABLE ajo_agent_earnings ADD CONSTRAINT ajo_agent_earnings_tier_check CHECK (tier IN (1, 2));
