-- Backup & restore: registry, society export/restore, platform export/DR loader, run history, private bucket.
-- Applied to staging (with a real-data test suite, rolled back) and then production. Idempotent: safe to re-run.
CREATE TABLE IF NOT EXISTS backup_registry (
  table_name text PRIMARY KEY, scope_sql text NOT NULL, pk_cols text[] NOT NULL, insert_order int NOT NULL,
  restore boolean NOT NULL DEFAULT true, note text);
CREATE TABLE IF NOT EXISTS backup_registry_excluded (table_name text PRIMARY KEY, reason text NOT NULL);
ALTER TABLE backup_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_registry_excluded ENABLE ROW LEVEL SECURITY;
DELETE FROM backup_registry;
INSERT INTO backup_registry (table_name, scope_sql, pk_cols, insert_order, restore, note) VALUES
 ('coop_societies','coop_id = $1','{coop_id}',0,false,'Platform-managed (subscription status, keys). Backed up, never overwritten by a restore, so an old copy cannot un-suspend an unpaid society.'),
 ('coop_society_addons','coop_id = $1','{id}',5,false,'Platform-managed entitlements.'),
 ('coop_subscription_payments','coop_id = $1','{id}',5,false,'Billing history is platform-owned.'),
 ('coop_terms_acceptances','coop_id = $1','{id}',5,false,'Legal acceptance record - must never be rewound.'),
 ('coop_portal_users','coop_id = $1','{id}',5,false,'Staff logins: an old copy could bring back a removed user or revert a credential.'),
 ('coop_portal_user_permissions','user_id IN (SELECT id FROM coop_portal_users WHERE coop_id = $1)','{id}',6,false,'Follows coop_portal_users.'),
 ('coop_savings_packages','coop_id = $1','{id}',10,true,NULL),('coop_loan_packages','coop_id = $1','{id}',10,true,NULL),
 ('coop_chart_of_accounts','coop_id = $1','{id}',10,true,NULL),('coop_investment_products','coop_id = $1','{id}',10,true,NULL),
 ('coop_members','coop_id = $1','{id}',10,true,NULL),('coop_journal_entries','coop_id = $1','{id}',10,true,NULL),
 ('coop_payroll_runs','coop_id = $1','{id}',10,true,NULL),('coop_statutory_remittances','coop_id = $1','{id}',10,true,NULL),
 ('coop_offline_transfer_claims','coop_id = $1','{id}',10,true,NULL),
 ('coop_savings_plans','coop_id = $1','{id}',20,true,NULL),('coop_journal_entry_lines','coop_id = $1','{id}',20,true,NULL),
 ('coop_financial_years','coop_id = $1','{id}',20,true,NULL),('coop_bank_reconciliation_batches','coop_id = $1','{id}',20,true,NULL),
 ('coop_employees','coop_id = $1','{id}',20,true,NULL),('coop_member_investments','coop_id = $1','{id}',20,true,NULL),
 ('coop_investment_venture_performance','product_id IN (SELECT id FROM coop_investment_products WHERE coop_id = $1)','{id}',20,true,NULL),
 ('coop_dues_transactions','coop_id = $1','{id}',20,true,NULL),('coop_share_transactions','coop_id = $1','{id}',20,true,NULL),
 ('coop_join_applications','coop_id = $1','{id}',20,true,NULL),('coop_notifications','coop_id = $1','{id}',20,true,NULL),
 ('coop_loans','coop_id = $1','{id}',30,true,NULL),('coop_savings_transactions','coop_id = $1','{id}',30,true,NULL),
 ('coop_dividend_runs','coop_id = $1','{id}',30,true,NULL),('coop_surplus_allocations','coop_id = $1','{id}',30,true,NULL),
 ('coop_bank_statement_lines','coop_id = $1','{id}',30,true,NULL),('coop_reconciliation_unmatched_records','coop_id = $1','{id}',30,true,NULL),
 ('coop_employee_salary_components','employee_id IN (SELECT id FROM coop_employees WHERE coop_id = $1)','{id}',30,true,NULL),
 ('coop_staff_loans','coop_id = $1','{id}',30,true,NULL),
 ('coop_investment_accruals','member_investment_id IN (SELECT id FROM coop_member_investments WHERE coop_id = $1)','{id}',30,true,NULL),
 ('coop_notification_reads','notification_id IN (SELECT id FROM coop_notifications WHERE coop_id = $1)','{notification_id,member_id}',30,true,NULL),
 ('coop_payroll_run_lines','payroll_run_id IN (SELECT id FROM coop_payroll_runs WHERE coop_id = $1)','{id}',30,true,NULL),
 ('coop_loan_repayments','loan_id IN (SELECT id FROM coop_loans WHERE coop_id = $1)','{id}',40,true,NULL),
 ('coop_loan_repayment_schedule','loan_id IN (SELECT id FROM coop_loans WHERE coop_id = $1)','{id}',40,true,NULL),
 ('coop_loan_guarantors','loan_id IN (SELECT id FROM coop_loans WHERE coop_id = $1)','{id}',40,true,NULL),
 ('coop_loan_penalties','coop_id = $1','{id}',40,true,NULL),
 ('coop_checkout_sessions','coop_id = $1','{id}',40,true,'Restored so payment sessions stay consistent with the ledger rows they created.'),
 ('coop_dividend_entitlements','coop_id = $1','{id}',40,true,NULL),
 ('coop_staff_loan_repayments','staff_loan_id IN (SELECT id FROM coop_staff_loans WHERE coop_id = $1)','{id}',40,true,NULL),
 ('coop_dividend_payouts','coop_id = $1','{id}',50,true,NULL);
DELETE FROM backup_registry_excluded;
INSERT INTO backup_registry_excluded VALUES
 ('cooperatives','Legacy module. Its coop_id is a DIFFERENT id space (references cooperatives, not coop_societies): platform backup only.'),
 ('cooperative_members','Legacy module - see cooperatives.'),
 ('ajo_schemes','Ajo module. Only points at a society through converted_to_coop_id; platform backup only.'),
 ('coop_addon_modules','Platform reference list of add-ons, not society data.'),
 ('backup_runs','Backup bookkeeping.'),('backup_registry','Backup bookkeeping.'),('backup_registry_excluded','Backup bookkeeping.');

CREATE OR REPLACE FUNCTION backup_registry_gaps() RETURNS TABLE(table_name text, why text) LANGUAGE sql STABLE AS $$
  SELECT DISTINCT c.table_name::text, 'has a coop_id column but is not in the backup registry or the exclusion list'::text
    FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name AND t.table_type='BASE TABLE'
   WHERE c.table_schema='public' AND c.column_name='coop_id'
     AND c.table_name::text NOT IN (SELECT r.table_name FROM backup_registry r) AND c.table_name::text NOT IN (SELECT e.table_name FROM backup_registry_excluded e)
  UNION
  SELECT DISTINCT con.conrelid::regclass::text, ('has a foreign key to ' || con.confrelid::regclass::text || ' (a backed-up table) but is not in the registry or the exclusion list')::text
    FROM pg_constraint con
   WHERE con.contype='f' AND con.connamespace='public'::regnamespace
     AND con.confrelid::regclass::text IN (SELECT r.table_name FROM backup_registry r)
     AND con.conrelid::regclass::text NOT IN (SELECT r.table_name FROM backup_registry r) AND con.conrelid::regclass::text NOT IN (SELECT e.table_name FROM backup_registry_excluded e);
$$;
CREATE OR REPLACE FUNCTION backup_registry_order_violations() RETURNS TABLE(child text, parent text) LANGUAGE sql STABLE AS $$
  SELECT con.conrelid::regclass::text, con.confrelid::regclass::text
    FROM pg_constraint con JOIN backup_registry c ON c.table_name = con.conrelid::regclass::text JOIN backup_registry p ON p.table_name = con.confrelid::regclass::text
   WHERE con.contype='f' AND con.connamespace='public'::regnamespace AND con.conrelid <> con.confrelid AND c.restore AND p.restore AND p.insert_order >= c.insert_order;
$$;

CREATE OR REPLACE FUNCTION backup_export_society(p_coop_id text) RETURNS text LANGUAGE plpgsql AS $fn$
DECLARE r record; t jsonb := '{}'::jsonb; cnt jsonb := '{}'::jsonb; cols jsonb := '{}'::jsonb; rows_j jsonb; ord text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM coop_societies WHERE coop_id = p_coop_id) THEN RAISE EXCEPTION 'Society % not found', p_coop_id; END IF;
  FOR r IN SELECT * FROM backup_registry ORDER BY insert_order, table_name LOOP
    SELECT string_agg(quote_ident(c), ', ') INTO ord FROM unnest(r.pk_cols) c;
    EXECUTE format('SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY %s), ''[]''::jsonb) FROM %I x WHERE %s', ord, r.table_name, r.scope_sql) INTO rows_j USING p_coop_id;
    t := t || jsonb_build_object(r.table_name, rows_j); cnt := cnt || jsonb_build_object(r.table_name, jsonb_array_length(rows_j));
    cols := cols || jsonb_build_object(r.table_name, (SELECT jsonb_agg(column_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name = r.table_name));
  END LOOP;
  RETURN jsonb_build_object('format','zillion-backup','version',1,'scope','society','coop_id',p_coop_id,'created_at',now(),'postgres',current_setting('server_version'),
    'registry',(SELECT jsonb_agg(to_jsonb(g) ORDER BY g.insert_order, g.table_name) FROM backup_registry g),'counts',cnt,'columns',cols,'tables',t)::text;
END $fn$;

CREATE OR REPLACE FUNCTION backup_restore_society(p_coop_id text, p_payload text, p_apply boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE
  v jsonb; r record; rows_j jsonb; pkjoin text; pkcols text; cur_cols text[]; bk_cols text[]; use_cols text; setlist text; plist text; tlist text;
  ins bigint; upd bigint; del bigint; oos bigint; after_n bigint;
  rep jsonb := '{}'::jsonb; drift jsonb := '[]'::jsonb; tot_i bigint := 0; tot_u bigint := 0; tot_d bigint := 0;
BEGIN
  v := p_payload::jsonb;
  IF v->>'format' IS DISTINCT FROM 'zillion-backup' OR (v->>'version')::int IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'This is not a Zillion backup file, or it is a version this system cannot read'; END IF;
  IF v->>'scope' IS DISTINCT FROM 'society' THEN RAISE EXCEPTION 'This is a % backup, not a society backup', v->>'scope'; END IF;
  IF v->>'coop_id' IS DISTINCT FROM p_coop_id THEN RAISE EXCEPTION 'This backup belongs to society %, not %', v->>'coop_id', p_coop_id; END IF;
  IF NOT EXISTS (SELECT 1 FROM coop_societies WHERE coop_id = p_coop_id) THEN RAISE EXCEPTION 'Society % not found', p_coop_id; END IF;
  IF p_apply THEN
    FOR r IN SELECT table_name FROM backup_registry WHERE restore ORDER BY table_name LOOP EXECUTE format('LOCK TABLE %I IN SHARE ROW EXCLUSIVE MODE', r.table_name); END LOOP;
  END IF;
  FOR r IN SELECT * FROM backup_registry WHERE restore ORDER BY insert_order, table_name LOOP
    IF NOT (v->'tables' ? r.table_name) THEN rep := rep || jsonb_build_object(r.table_name, jsonb_build_object('skipped','not in this backup')); CONTINUE; END IF;
    rows_j := v->'tables'->r.table_name;
    SELECT string_agg(format('p.%1$I = t.%1$I', c), ' AND ') INTO pkjoin FROM unnest(r.pk_cols) c;
    SELECT array_agg(column_name::text ORDER BY ordinal_position) INTO cur_cols FROM information_schema.columns WHERE table_schema='public' AND table_name = r.table_name;
    SELECT array_agg(x) INTO bk_cols FROM jsonb_array_elements_text(COALESCE(v->'columns'->r.table_name, '[]'::jsonb)) x;
    IF EXISTS (SELECT 1 FROM unnest(COALESCE(bk_cols,'{}')) c WHERE c <> ALL(cur_cols)) THEN
      drift := drift || jsonb_build_object('table', r.table_name, 'columns_no_longer_in_database', (SELECT jsonb_agg(c) FROM unnest(bk_cols) c WHERE c <> ALL(cur_cols)));
    END IF;
    SELECT string_agg('p.'||quote_ident(c), ', '), string_agg('t.'||quote_ident(c), ', ') INTO plist, tlist FROM unnest(COALESCE(bk_cols,'{}')) c WHERE c = ANY(cur_cols);
    EXECUTE format('SELECT count(*) FROM jsonb_populate_recordset(null::%1$I, $2) p WHERE EXISTS (SELECT 1 FROM %1$I t WHERE %2$s) AND NOT EXISTS (SELECT 1 FROM %1$I t WHERE %2$s AND (%3$s))', r.table_name, pkjoin, r.scope_sql) INTO oos USING p_coop_id, rows_j;
    IF oos > 0 THEN RAISE EXCEPTION 'Refused: % row(s) in % collide with data that belongs to a different society', oos, r.table_name; END IF;
    EXECUTE format('SELECT count(*) FROM jsonb_populate_recordset(null::%1$I, $1) p WHERE NOT EXISTS (SELECT 1 FROM %1$I t WHERE %2$s)', r.table_name, pkjoin) INTO ins USING rows_j;
    EXECUTE format('SELECT count(*) FROM %1$I t WHERE %2$s AND NOT EXISTS (SELECT 1 FROM jsonb_populate_recordset(null::%1$I, $2) p WHERE %3$s)', r.table_name, r.scope_sql, pkjoin) INTO del USING p_coop_id, rows_j;
    EXECUTE format('SELECT count(*) FROM jsonb_populate_recordset(null::%1$I, $1) p JOIN %1$I t ON %2$s WHERE (%3$s) IS DISTINCT FROM (%4$s)', r.table_name, pkjoin, plist, tlist) INTO upd USING rows_j;
    tot_i := tot_i + ins; tot_u := tot_u + upd; tot_d := tot_d + del;
    rep := rep || jsonb_build_object(r.table_name, jsonb_build_object('rows_in_backup', jsonb_array_length(rows_j), 'will_add', ins, 'will_change', upd, 'will_remove', del));
  END LOOP;
  IF NOT p_apply THEN RETURN jsonb_build_object('applied', false, 'totals', jsonb_build_object('add', tot_i, 'change', tot_u, 'remove', tot_d), 'schema_drift', drift, 'tables', rep); END IF;
  FOR r IN SELECT * FROM backup_registry WHERE restore ORDER BY insert_order DESC, table_name LOOP
    CONTINUE WHEN NOT (v->'tables' ? r.table_name);
    SELECT string_agg(format('p.%1$I = t.%1$I', c), ' AND ') INTO pkjoin FROM unnest(r.pk_cols) c;
    EXECUTE format('DELETE FROM %1$I t WHERE %2$s AND NOT EXISTS (SELECT 1 FROM jsonb_populate_recordset(null::%1$I, $2) p WHERE %3$s)', r.table_name, r.scope_sql, pkjoin) USING p_coop_id, v->'tables'->r.table_name;
  END LOOP;
  FOR r IN SELECT * FROM backup_registry WHERE restore ORDER BY insert_order, table_name LOOP
    CONTINUE WHEN NOT (v->'tables' ? r.table_name);
    SELECT array_agg(column_name::text ORDER BY ordinal_position) INTO cur_cols FROM information_schema.columns WHERE table_schema='public' AND table_name = r.table_name;
    SELECT array_agg(x) INTO bk_cols FROM jsonb_array_elements_text(COALESCE(v->'columns'->r.table_name, '[]'::jsonb)) x;
    SELECT string_agg(quote_ident(c), ', ') INTO use_cols FROM unnest(COALESCE(bk_cols,'{}')) c WHERE c = ANY(cur_cols);
    SELECT string_agg(quote_ident(c), ', ') INTO pkcols FROM unnest(r.pk_cols) c;
    SELECT string_agg(format('%1$I = EXCLUDED.%1$I', c), ', ') INTO setlist FROM unnest(COALESCE(bk_cols,'{}')) c WHERE c = ANY(cur_cols) AND c <> ALL(r.pk_cols);
    IF jsonb_array_length(v->'tables'->r.table_name) > 0 THEN
      EXECUTE format('INSERT INTO %1$I (%2$s) SELECT %2$s FROM jsonb_populate_recordset(null::%1$I, $1) ON CONFLICT (%3$s) DO %4$s',
        r.table_name, use_cols, pkcols, CASE WHEN setlist IS NULL THEN 'NOTHING' ELSE 'UPDATE SET ' || setlist END) USING v->'tables'->r.table_name;
    END IF;
  END LOOP;
  FOR r IN SELECT * FROM backup_registry WHERE restore ORDER BY insert_order, table_name LOOP
    CONTINUE WHEN NOT (v->'tables' ? r.table_name);
    EXECUTE format('SELECT count(*) FROM %I x WHERE %s', r.table_name, r.scope_sql) INTO after_n USING p_coop_id;
    IF after_n <> jsonb_array_length(v->'tables'->r.table_name) THEN
      RAISE EXCEPTION 'Verification failed for %: the backup holds % rows but % are in the database after restoring - nothing has been changed', r.table_name, jsonb_array_length(v->'tables'->r.table_name), after_n;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('applied', true, 'totals', jsonb_build_object('add', tot_i, 'change', tot_u, 'remove', tot_d), 'schema_drift', drift, 'tables', rep);
END $fn$;

CREATE TABLE IF NOT EXISTS backup_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('society','platform')), coop_id text,
  kind text NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual','scheduled','pre_restore')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','failed','deleted')),
  storage_path text, bytes bigint, sha256 text,
  key_kind text NOT NULL DEFAULT 'none' CHECK (key_kind IN ('none','server','passphrase')),
  table_counts jsonb, created_by text, created_at timestamptz NOT NULL DEFAULT now(), error text);
CREATE INDEX IF NOT EXISTS idx_backup_runs_scope ON backup_runs (scope, coop_id, created_at DESC);
ALTER TABLE backup_runs ENABLE ROW LEVEL SECURITY;
INSERT INTO storage.buckets (id, name, public, file_size_limit) VALUES ('backups','backups', false, 52428800) ON CONFLICT (id) DO UPDATE SET public = false;

CREATE OR REPLACE FUNCTION backup_export_platform() RETURNS text LANGUAGE plpgsql AS $fn$
DECLARE r record; t jsonb := '{}'::jsonb; cnt jsonb := '{}'::jsonb; cols jsonb := '{}'::jsonb; rows_j jsonb; ord text;
BEGIN
  FOR r IN SELECT c.oid, c.relname AS tn FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND c.relname <> 'backup_runs' ORDER BY c.relname LOOP
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY array_position(i.indkey::int2[], a.attnum)) INTO ord
      FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = r.oid AND i.indisprimary;
    EXECUTE format('SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY %s), ''[]''::jsonb) FROM %I x', COALESCE(ord, 'to_jsonb(x)::text'), r.tn) INTO rows_j;
    t := t || jsonb_build_object(r.tn, rows_j); cnt := cnt || jsonb_build_object(r.tn, jsonb_array_length(rows_j));
    cols := cols || jsonb_build_object(r.tn, (SELECT jsonb_agg(column_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name = r.tn));
  END LOOP;
  RETURN jsonb_build_object('format','zillion-backup','version',1,'scope','platform','created_at',now(),'postgres',current_setting('server_version'),
    'note','Data plus a description of the schema. To rebuild a database from nothing, create the schema first (supabase db dump --schema-only, or your migrations), then load this with backup_load_platform().',
    'foreign_keys',(SELECT jsonb_agg(jsonb_build_object('child', conrelid::regclass::text, 'parent', confrelid::regclass::text, 'definition', pg_get_constraintdef(oid))) FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace),
    'indexes',(SELECT jsonb_agg(indexdef) FROM pg_indexes WHERE schemaname='public'),'counts',cnt,'columns',cols,'tables',t)::text;
END $fn$;

CREATE OR REPLACE FUNCTION backup_load_platform(p_payload text, p_schema text DEFAULT 'public', p_apply boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v jsonb; r record; cols text; n_before bigint; n_ins bigint := 0; tot bigint := 0; rep jsonb := '{}'::jsonb; missing jsonb := '[]'::jsonb; seq record; mx bigint;
BEGIN
  IF p_schema !~ '^[a-z_][a-z0-9_]*$' THEN RAISE EXCEPTION 'Invalid schema name'; END IF;
  v := p_payload::jsonb;
  IF v->>'format' IS DISTINCT FROM 'zillion-backup' OR (v->>'version')::int IS DISTINCT FROM 1 OR v->>'scope' IS DISTINCT FROM 'platform' THEN RAISE EXCEPTION 'This is not a Zillion platform backup file'; END IF;
  IF p_apply THEN SET LOCAL session_replication_role = 'replica'; END IF;
  FOR r IN SELECT key AS tn, value AS rows FROM jsonb_each(v->'tables') ORDER BY key LOOP
    IF to_regclass(format('%I.%I', p_schema, r.tn)) IS NULL THEN missing := missing || to_jsonb(r.tn); CONTINUE; END IF;
    EXECUTE format('SELECT count(*) FROM %I.%I', p_schema, r.tn) INTO n_before;
    SELECT string_agg(quote_ident(c), ', ') INTO cols FROM jsonb_array_elements_text(COALESCE(v->'columns'->r.tn, '[]'::jsonb)) c
      WHERE c IN (SELECT column_name FROM information_schema.columns WHERE table_schema = p_schema AND table_name = r.tn);
    n_ins := 0;
    IF p_apply AND jsonb_array_length(r.rows) > 0 AND cols IS NOT NULL THEN
      EXECUTE format('INSERT INTO %1$I.%2$I (%3$s) SELECT %3$s FROM jsonb_populate_recordset(null::%1$I.%2$I, $1) ON CONFLICT DO NOTHING', p_schema, r.tn, cols) USING r.rows;
      GET DIAGNOSTICS n_ins = ROW_COUNT;
    END IF;
    tot := tot + n_ins;
    rep := rep || jsonb_build_object(r.tn, jsonb_build_object('rows_in_backup', jsonb_array_length(r.rows), 'rows_before', n_before, 'inserted', n_ins));
  END LOOP;
  IF p_apply THEN
    FOR seq IN SELECT a.attrelid::regclass::text AS reln, a.attname AS col, pg_get_serial_sequence(a.attrelid::regclass::text, a.attname) AS sq
               FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = p_schema AND c.relkind='r' AND a.attnum > 0 AND NOT a.attisdropped AND pg_get_serial_sequence(a.attrelid::regclass::text, a.attname) IS NOT NULL LOOP
      EXECUTE format('SELECT max(%I) FROM %s', seq.col, seq.reln) INTO mx;
      IF mx IS NOT NULL THEN PERFORM setval(seq.sq, mx, true); END IF;
    END LOOP;
  END IF;
  RETURN jsonb_build_object('applied', p_apply, 'schema', p_schema, 'total_inserted', tot, 'tables_missing_in_target', missing, 'tables', rep);
END $fn$;

REVOKE ALL ON FUNCTION backup_registry_gaps(), backup_registry_order_violations(), backup_export_society(text), backup_restore_society(text,text,boolean), backup_export_platform(), backup_load_platform(text,text,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION backup_registry_gaps(), backup_registry_order_violations(), backup_export_society(text), backup_restore_society(text,text,boolean), backup_export_platform(), backup_load_platform(text,text,boolean) TO service_role;
