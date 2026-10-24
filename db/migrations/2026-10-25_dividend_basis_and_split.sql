-- Go-live phase 5: how a dividend run was worked out, and how much of it rests on imported history.
ALTER TABLE coop_dividend_runs
  ADD COLUMN IF NOT EXISTS share_basis    text    NOT NULL DEFAULT 'year_end',
  ADD COLUMN IF NOT EXISTS savings_basis  text    NOT NULL DEFAULT 'net',
  ADD COLUMN IF NOT EXISTS includes_exited boolean NOT NULL DEFAULT false;

ALTER TABLE coop_dividend_entitlements
  ADD COLUMN IF NOT EXISTS member_status                 text,
  ADD COLUMN IF NOT EXISTS year_end_share_capital_kobo   bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS imported_patronage_kobo       bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS live_patronage_kobo           bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS imported_share_capital_kobo   bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS live_share_capital_kobo       bigint NOT NULL DEFAULT 0;
