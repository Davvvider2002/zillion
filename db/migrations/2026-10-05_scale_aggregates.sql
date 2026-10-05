-- Scale: let the database do the adding.
-- The society dashboard used to download EVERY savings/dues/share transaction a society ever recorded, 1,000 rows
-- at a time with offset paging, just to add them up per plan/member in JavaScript. Measured on a 5,000-member /
-- 150,000-transaction society: 5.7s of database time for savings alone (and each page slower than the last),
-- before 150 network round trips - past Netlify's 10s function limit. The same sums as a GROUP BY: 44ms.
-- Each function returns ONE jsonb object (a map), so the 1,000-row API cap cannot truncate it and it costs one round
-- trip. Locked to the service role: nobody holding the public anon key can call them, whatever p_coop_id they pass.

CREATE OR REPLACE FUNCTION coop_sum_savings_by_plan(p_coop_id text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT coalesce(jsonb_object_agg(savings_plan_id::text, total), '{}'::jsonb)
  FROM (SELECT savings_plan_id, sum(amount_kobo)::bigint AS total FROM coop_savings_transactions
        WHERE coop_id = p_coop_id AND savings_plan_id IS NOT NULL GROUP BY savings_plan_id) s
$$;

CREATE OR REPLACE FUNCTION coop_sum_dues_by_member(p_coop_id text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT coalesce(jsonb_object_agg(member_id::text, total), '{}'::jsonb)
  FROM (SELECT member_id, sum(amount_kobo)::bigint AS total FROM coop_dues_transactions
        WHERE coop_id = p_coop_id AND member_id IS NOT NULL GROUP BY member_id) s
$$;

CREATE OR REPLACE FUNCTION coop_sum_shares_by_member(p_coop_id text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT coalesce(jsonb_object_agg(member_id::text, total), '{}'::jsonb)
  FROM (SELECT member_id, sum(amount_kobo)::bigint AS total FROM coop_share_transactions
        WHERE coop_id = p_coop_id AND member_id IS NOT NULL GROUP BY member_id) s
$$;

-- Everything the dashboard Analytics card needs, in one call. Months are bucketed in UTC (the server's own clock).
-- p_since is the first day of the oldest month shown.
CREATE OR REPLACE FUNCTION coop_dashboard_analytics(p_coop_id text, p_since date) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT jsonb_build_object(
    'members_before_window', (SELECT count(*) FROM coop_members
        WHERE coop_id = p_coop_id AND activated_at IS NOT NULL AND activated_at < (p_since::timestamp AT TIME ZONE 'UTC')),
    'members_by_month', (SELECT coalesce(jsonb_object_agg(k, n), '{}'::jsonb) FROM (
        SELECT to_char(activated_at AT TIME ZONE 'UTC', 'YYYY-MM') AS k, count(*) AS n FROM coop_members
        WHERE coop_id = p_coop_id AND activated_at IS NOT NULL AND activated_at >= (p_since::timestamp AT TIME ZONE 'UTC') GROUP BY 1) m),
    'savings_by_month', (SELECT coalesce(jsonb_object_agg(k, total), '{}'::jsonb) FROM (
        SELECT to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM') AS k, sum(amount_kobo)::bigint AS total FROM coop_savings_transactions
        WHERE coop_id = p_coop_id AND recorded_at IS NOT NULL AND recorded_at >= (p_since::timestamp AT TIME ZONE 'UTC') GROUP BY 1) s),
    'loan_status', (SELECT coalesce(jsonb_object_agg(st, jsonb_build_object('count', n, 'principal_kobo', p)), '{}'::jsonb) FROM (
        SELECT coalesce(status, 'UNKNOWN') AS st, count(*) AS n, coalesce(sum(principal_kobo), 0)::bigint AS p FROM coop_loans
        WHERE coop_id = p_coop_id GROUP BY 1) l),
    'total_dues_kobo', (SELECT coalesce(sum(amount_kobo), 0)::bigint FROM coop_dues_transactions WHERE coop_id = p_coop_id)
  )
$$;

DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY['coop_sum_savings_by_plan(text)','coop_sum_dues_by_member(text)','coop_sum_shares_by_member(text)','coop_dashboard_analytics(text,date)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;
