-- ============================================================
-- ZILLION — Cooperative Thrift & Loan module (savings + loan lifecycle)
-- Applied directly to production AND staging.
--
-- Loan status flow: PENDING_GUARANTOR -> PENDING_APPROVAL -> APPROVED
--                    -> DISBURSED -> REPAYING -> COMPLETED
--                    (or REJECTED / DEFAULTED at various points)
--
-- Member-initiated (competitive gap #2): a member applies for their own
-- loan; admin approves, doesn't create loan records unilaterally.
-- Guarantor tracking (competitive gap #1): a loan needs another member
-- to vouch for it — standard practice in Nigerian cooperative lending,
-- was previously absent from the design entirely.
-- ============================================================

CREATE TABLE IF NOT EXISTS coop_savings_plans (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coop_id                   TEXT NOT NULL REFERENCES coop_societies(coop_id),
  member_id                 UUID NOT NULL REFERENCES coop_members(id),
  target_amount_kobo        BIGINT NOT NULL,
  monthly_contribution_kobo BIGINT NOT NULL,
  duration_months           INTEGER NOT NULL,
  start_date                DATE NOT NULL DEFAULT CURRENT_DATE,
  status                    TEXT NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE | COMPLETED | CANCELLED
  created_by                TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS coop_loans (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coop_id                 TEXT NOT NULL REFERENCES coop_societies(coop_id),
  member_id               UUID NOT NULL REFERENCES coop_members(id),
  savings_plan_id         UUID REFERENCES coop_savings_plans(id),
  principal_kobo          BIGINT NOT NULL,
  repayment_months        INTEGER NOT NULL,
  monthly_repayment_kobo  BIGINT NOT NULL,
  guarantor_member_id     UUID REFERENCES coop_members(id),
  guarantor_status        TEXT NOT NULL DEFAULT 'PENDING',            -- PENDING | APPROVED | DECLINED
  status                  TEXT NOT NULL DEFAULT 'PENDING_GUARANTOR',  -- see flow above
  requested_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at             TIMESTAMPTZ,
  approved_by             TEXT,
  disbursed_at            TIMESTAMPTZ,
  rejection_reason        TEXT,
  CHECK (member_id != guarantor_member_id)  -- a member cannot guarantee their own loan
);

CREATE INDEX IF NOT EXISTS idx_savings_plans_member ON coop_savings_plans(member_id);
CREATE INDEX IF NOT EXISTS idx_loans_member         ON coop_loans(member_id);
CREATE INDEX IF NOT EXISTS idx_loans_guarantor      ON coop_loans(guarantor_member_id);
CREATE INDEX IF NOT EXISTS idx_loans_status         ON coop_loans(status);

ALTER TABLE coop_savings_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE coop_loans ENABLE ROW LEVEL SECURITY;
