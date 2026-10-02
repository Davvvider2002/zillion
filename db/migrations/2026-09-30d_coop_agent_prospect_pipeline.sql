-- Channel Partner (Coop Agent) prospect pipeline: an agent tracks cooperative societies they're pursuing,
-- logging one engagement report per meeting/demo. Zillion Admin reviews the resulting pipeline, classifies
-- leads (A-D), and assigns follow-up - this is the CRM workflow, not a paper form.
--
-- Two tables: coop_agent_prospects (the cooperative society itself, one row, updated as the relationship
-- progresses) and coop_agent_engagement_reports (one row per meeting - the history). Lead grading, account
-- manager assignment, and internal review flags (the form's Section 13) are Zillion-Admin-only fields on the
-- prospect, never set by the agent themselves. Applied to staging then production, both clean (0
-- backup-registry gaps/order violations).
--
-- Deliberately does NOT cover the form's Section 14 (file attachments) - that needs its own storage
-- infrastructure not yet set up for this surface. Scoped out explicitly, not silently dropped.
CREATE TABLE IF NOT EXISTS coop_agent_prospects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES coop_agents(id),
  cooperative_name text NOT NULL,
  registration_number text,
  location text,
  state text,
  member_count_band text CHECK (member_count_band IS NULL OR member_count_band IN ('1-50','51-100','101-250','251-500','501-1000','1001-5000','5000+')),
  estimated_active_members integer,
  cooperative_type text CHECK (cooperative_type IS NULL OR cooperative_type IN ('THRIFT_CREDIT','MULTIPURPOSE','AGRICULTURAL','STAFF_EMPLOYEES','HOUSING','INVESTMENT','COMMUNITY_BASED','PROFESSIONAL_ASSOCIATION','OTHER')),
  current_management_method text CHECK (current_management_method IS NULL OR current_management_method IN ('MANUAL_PAPER','EXCEL_SPREADSHEET','WHATSAPP','EXISTING_COOP_SOFTWARE','ACCOUNTING_SOFTWARE','COMBINATION','OTHER')),
  current_software_name text,
  lead_status text NOT NULL DEFAULT 'QUALIFIED' CHECK (lead_status IN ('HOT','WARM','QUALIFIED','NURTURE','NOT_INTERESTED')),
  estimated_onboarding_timeline text,
  lead_grade text CHECK (lead_grade IS NULL OR lead_grade IN ('A','B','C','D')),
  assigned_account_manager text,
  technical_review_required boolean NOT NULL DEFAULT false,
  customisation_review_required boolean NOT NULL DEFAULT false,
  management_escalation_required boolean NOT NULL DEFAULT false,
  internal_comments text,
  converted_to_coop_id text REFERENCES coop_societies(coop_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_coop_agent_prospects_agent ON coop_agent_prospects(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_coop_agent_prospects_grade ON coop_agent_prospects(lead_grade) WHERE lead_grade IS NOT NULL;
ALTER TABLE coop_agent_prospects ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS coop_agent_engagement_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id uuid NOT NULL REFERENCES coop_agent_prospects(id),
  agent_id uuid NOT NULL REFERENCES coop_agents(id),
  engagement_date date NOT NULL,
  start_time text,
  meeting_type text CHECK (meeting_type IS NULL OR meeting_type IN ('PHYSICAL','ZOOM','WHATSAPP','PHONE','OTHER')),
  location_or_platform text,
  engagement_type text CHECK (engagement_type IS NULL OR engagement_type IN ('FIRST_INTRODUCTION','PRODUCT_DEMO','FOLLOW_UP','ONBOARDING','RENEWAL_UPGRADE')),
  duration_band text CHECK (duration_band IS NULL OR duration_band IN ('UNDER_30MIN','30_60MIN','1_2HR','2HR_PLUS')),
  people_present jsonb NOT NULL DEFAULT '[]',
  key_decision_maker_name text,
  key_decision_maker_position text,
  key_decision_maker_contact text,
  features_demonstrated jsonb NOT NULL DEFAULT '[]',
  overall_reaction text CHECK (overall_reaction IS NULL OR overall_reaction IN ('VERY_POSITIVE','POSITIVE','NEUTRAL','CONCERNED','NEGATIVE')),
  top_attractions jsonb NOT NULL DEFAULT '[]',
  most_impressive_feature text,
  pain_points jsonb NOT NULL DEFAULT '[]',
  biggest_problem_description text,
  feature_requests jsonb NOT NULL DEFAULT '[]',
  customisation_category text,
  customisation_explanation text,
  customisation_essential text CHECK (customisation_essential IS NULL OR customisation_essential IN ('YES','NO','CAN_ONBOARD_WITHOUT','TO_BE_DISCUSSED')),
  questions_asked jsonb NOT NULL DEFAULT '[]',
  objections jsonb NOT NULL DEFAULT '[]',
  objection_details text,
  objection_resolution text,
  needs_further_response boolean NOT NULL DEFAULT false,
  required_response text,
  current_members_estimate integer,
  potential_members_estimate integer,
  commercial_interest jsonb NOT NULL DEFAULT '[]',
  pricing_discussed boolean NOT NULL DEFAULT false,
  plan_discussed text,
  quoted_amount_kobo bigint,
  addons_of_interest jsonb NOT NULL DEFAULT '[]',
  lead_status text NOT NULL CHECK (lead_status IN ('HOT','WARM','QUALIFIED','NURTURE','NOT_INTERESTED')),
  estimated_onboarding_timeline text,
  next_actions jsonb NOT NULL DEFAULT '[]',
  next_meeting_date date,
  responsible_person text,
  expected_outcome text,
  rating_customer_interest smallint CHECK (rating_customer_interest IS NULL OR rating_customer_interest BETWEEN 1 AND 5),
  rating_product_fit smallint CHECK (rating_product_fit IS NULL OR rating_product_fit BETWEEN 1 AND 5),
  rating_commercial_potential smallint CHECK (rating_commercial_potential IS NULL OR rating_commercial_potential BETWEEN 1 AND 5),
  rating_decision_maker_engagement smallint CHECK (rating_decision_maker_engagement IS NULL OR rating_decision_maker_engagement BETWEEN 1 AND 5),
  rating_likelihood_onboarding smallint CHECK (rating_likelihood_onboarding IS NULL OR rating_likelihood_onboarding BETWEEN 1 AND 5),
  biggest_opportunity text,
  adoption_blockers text,
  would_recommend text CHECK (would_recommend IS NULL OR would_recommend IN ('DEFINITELY','PROBABLY','NOT_SURE','PROBABLY_NOT')),
  summary text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_coop_agent_engagement_reports_prospect ON coop_agent_engagement_reports(prospect_id, engagement_date DESC);
CREATE INDEX IF NOT EXISTS idx_coop_agent_engagement_reports_agent ON coop_agent_engagement_reports(agent_id, engagement_date DESC);
ALTER TABLE coop_agent_engagement_reports ENABLE ROW LEVEL SECURITY;

INSERT INTO backup_registry_excluded (table_name, reason) VALUES
  ('coop_agent_prospects', 'Agent-owned pipeline data, not scoped to any one coop_id until conversion (many never convert) - platform-wide, same treatment as coop_agents.'),
  ('coop_agent_engagement_reports', 'Scoped through coop_agent_prospects - same reasoning.')
ON CONFLICT (table_name) DO NOTHING;
