-- Member wallet number change requests.
-- Zillion staff (SUPER_ADMIN or OPERATIONS) send a one time link to a society member. The member opens the link, enters the new number
-- (verified by a text message code), gives a reason and attaches proof. The request lands in the staff queue where it can be approved,
-- rejected, or sent back for more proof. Approval moves the wallet identity to the new number.
-- Apply to staging first, then production. Safe to run twice.

INSERT INTO storage.buckets (id, name, public, file_size_limit) VALUES
  ('member-phone-change-proofs', 'member-phone-change-proofs', false, 10485760)
ON CONFLICT (id) DO UPDATE SET public = false;

CREATE TABLE IF NOT EXISTS coop_member_phone_change_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coop_id         text NOT NULL REFERENCES coop_societies(coop_id),
  member_id       uuid NOT NULL REFERENCES coop_members(id),
  member_name     text,
  zillion_id      text,
  old_phone       text NOT NULL,
  new_phone       text,
  reason          text,
  status          text NOT NULL DEFAULT 'LINK_SENT'
                  CHECK (status IN ('LINK_SENT','SUBMITTED','MORE_PROOF_REQUESTED','APPROVED','REJECTED','CANCELLED')),
  token_hash      text NOT NULL,
  expires_at      timestamptz NOT NULL,
  otp_verified_at timestamptz,
  proof           jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{path, name, mime, uploaded_at}]
  admin_note      text,                                  -- latest message to the member (reject reason or what proof is needed)
  link_note       text,                                  -- why staff sent the link
  created_by      text NOT NULL,
  decided_by      text,
  decided_at      timestamptz,
  submitted_at    timestamptz,
  applied_changes jsonb,                                 -- what approval changed, kept so it can be reversed by hand
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_mpcr_token ON coop_member_phone_change_requests(token_hash);
-- One open request per member at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_mpcr_open_per_member ON coop_member_phone_change_requests(member_id)
  WHERE status IN ('LINK_SENT','SUBMITTED','MORE_PROOF_REQUESTED');
CREATE INDEX IF NOT EXISTS idx_mpcr_status ON coop_member_phone_change_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mpcr_coop ON coop_member_phone_change_requests(coop_id, created_at DESC);
ALTER TABLE coop_member_phone_change_requests ENABLE ROW LEVEL SECURITY;

INSERT INTO backup_registry (table_name, scope_sql, pk_cols, insert_order, restore) VALUES
  ('coop_member_phone_change_requests', 'coop_id = $1', ARRAY['id'], 60, true)
ON CONFLICT (table_name) DO NOTHING;
