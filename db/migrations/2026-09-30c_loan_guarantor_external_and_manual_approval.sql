-- External guarantors (not existing cooperative members) and a manual admin-override approval path, alongside
-- the existing wallet self-service one. An external guarantor has no wallet/member_id to respond from, so
-- their approval is always manual; a member guarantor can now ALSO be approved manually (an admin override,
-- for a guarantor who can't get to their phone), not only via their own wallet as before. Applied to staging
-- then production, both clean (0 backup-registry gaps/order violations).
ALTER TABLE coop_loan_guarantors ALTER COLUMN member_id DROP NOT NULL;
ALTER TABLE coop_loan_guarantors
  ADD COLUMN IF NOT EXISTS is_external boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS external_name text,
  ADD COLUMN IF NOT EXISTS external_id_type text,
  ADD COLUMN IF NOT EXISTS external_id_encrypted text,
  ADD COLUMN IF NOT EXISTS approved_by text;
ALTER TABLE coop_loan_guarantors ADD CONSTRAINT coop_loan_guarantors_external_id_type_check
  CHECK (external_id_type IS NULL OR external_id_type IN ('NIN', 'PASSPORT', 'DRIVERS_LICENSE', 'VOTERS_CARD'));
-- Data integrity: a row is either a real member (member_id set, no external fields) or a full external
-- guarantor (all three external fields set, no member_id) — never a half-filled mix of both.
ALTER TABLE coop_loan_guarantors ADD CONSTRAINT coop_loan_guarantors_member_xor_external_check
  CHECK (
    (is_external = false AND member_id IS NOT NULL AND external_name IS NULL AND external_id_type IS NULL AND external_id_encrypted IS NULL)
    OR
    (is_external = true AND member_id IS NULL AND external_name IS NOT NULL AND external_id_type IS NOT NULL AND external_id_encrypted IS NOT NULL)
  );
