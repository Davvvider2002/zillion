-- Correction: agents recruit/onboard cooperative societies for the Coop SaaS subscription — not Ajo schemes.
-- Collectors remain purely an Ajo concept (field cash collection), untouched by this migration.
-- Near-zero real data existed under the old scoping (1 test agent, 0 attributions, 0 earnings), so this is a
-- clean rename + repurpose rather than a data-preserving migration. Applied to staging then production, both
-- confirmed clean (0 backup-registry gaps/order violations).

ALTER TABLE ajo_agents RENAME TO coop_agents;

ALTER TABLE ajo_referral_attributions RENAME TO coop_referral_attributions;
ALTER TABLE coop_referral_attributions DROP CONSTRAINT IF EXISTS ajo_referral_attributions_scheme_id_key;
ALTER TABLE coop_referral_attributions DROP COLUMN scheme_id;
ALTER TABLE coop_referral_attributions ADD COLUMN coop_id text REFERENCES coop_societies(coop_id);
ALTER TABLE coop_referral_attributions ADD CONSTRAINT coop_referral_attributions_coop_id_key UNIQUE (coop_id);

ALTER TABLE ajo_agent_earnings RENAME TO coop_agent_earnings;
ALTER TABLE coop_agent_earnings DROP CONSTRAINT IF EXISTS ajo_agent_earnings_source_fee_event_type_check;
ALTER TABLE coop_agent_earnings ADD CONSTRAINT coop_agent_earnings_source_fee_event_type_check CHECK (source_fee_event_type = 'subscription_payment');

-- The old model let one person be "the same identity" as both an agent and a collector, cross-linked via this
-- column. That cross-link no longer means anything once agents (Coop) and collectors (Ajo) are cleanly
-- separate domains — dropped along with the scheme-creation code that maintained it.
ALTER TABLE coop_agents DROP COLUMN IF EXISTS collector_profile_id;

-- coop_referral_attributions now genuinely belongs to one society — registered as restorable, per-society data.
-- coop_agents and coop_agent_earnings stay platform-wide (an agent isn't owned by any one society), same
-- treatment ajo_agents/ajo_agent_earnings already had.
INSERT INTO backup_registry (table_name, scope_sql, pk_cols, insert_order, restore) VALUES
  ('coop_referral_attributions', 'coop_id = $1', ARRAY['id'], 51, true)
ON CONFLICT (table_name) DO NOTHING;
INSERT INTO backup_registry_excluded (table_name, reason) VALUES
  ('coop_agents', 'Platform-wide — an agent is not owned by any one society, they can refer many. Same treatment ajo_agents had.'),
  ('coop_agent_earnings', 'Platform-wide — see coop_agents.')
ON CONFLICT (table_name) DO NOTHING;
