-- Member-submitted KYC profile fields: date of birth (identity confirmation), and the encrypted-at-rest raw
-- NIN a member submits from their wallet, which coopDojahNin.js decrypts only in-memory during the admin's
-- verify action and clears the moment a match is confirmed. Applied to staging then production, both clean
-- (0 backup-registry gaps/order-violations — new columns on an already-registered table need no registry
-- change). Idempotent.
ALTER TABLE coop_members
  ADD COLUMN IF NOT EXISTS date_of_birth date,
  ADD COLUMN IF NOT EXISTS nin_encrypted text,
  ADD COLUMN IF NOT EXISTS nin_submitted_at timestamptz;
