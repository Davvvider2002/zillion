-- Public account-deletion requests (Google Play "Delete account" web link: zillion.ng/delete-account).
-- Written only by the account-deletion-request function (service role). Staff verify the person by calling the
-- registered number, then action the request and record the outcome here.
CREATE TABLE IF NOT EXISTS account_deletion_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone        text NOT NULL,
  full_name    text NOT NULL,
  email        text,
  scope        text NOT NULL DEFAULT 'account' CHECK (scope IN ('account', 'data_only')),
  reason       text,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'completed', 'declined')),
  ip_hash      text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  handled_at   timestamptz,
  handled_note text
);
CREATE INDEX IF NOT EXISTS idx_adr_phone_status ON account_deletion_requests (phone, status);
CREATE INDEX IF NOT EXISTS idx_adr_created ON account_deletion_requests (created_at DESC);
ALTER TABLE account_deletion_requests ENABLE ROW LEVEL SECURITY;
