-- Optional NIPOST digital postcode (NDAPS) capture. Stored as the compact 11-character form (e.g. FC02A09DB09),
-- format-checked by the application (lib/ngPostcode.js) rather than a CHECK constraint, so the format can be
-- adjusted in one place if NIPOST's still-settling docs change it. Self-declared for now; nothing here claims
-- the postcode has been verified against NIPOST's API.
-- Members: coop_members.postcode. Paid-join applicants: coop_join_applications.postcode (carried over to the
-- member on payment). External (non-member) loan guarantors: coop_loan_guarantors.external_postcode - a MEMBER
-- guarantor's postcode is simply their own coop_members.postcode.
-- Applied to staging then production, both clean (0 backup-registry gaps/order violations).
ALTER TABLE coop_members ADD COLUMN IF NOT EXISTS postcode text;
ALTER TABLE coop_join_applications ADD COLUMN IF NOT EXISTS postcode text;
ALTER TABLE coop_loan_guarantors ADD COLUMN IF NOT EXISTS external_postcode text;
