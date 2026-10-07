-- The society's bank account, seen through its books: opening balance, money in, money out and closing balance for one account
-- over a period, added up by the database (one small answer, not every journal line). Used by the Flutterwave bank-account
-- monitor to show what actually moved through the account Flutterwave settles into. 'In' = debits (an asset account grows),
-- 'out' = credits. Dates are the journal entries' own dates.
CREATE OR REPLACE FUNCTION coop_account_period_totals(p_coop_id text, p_account_code text, p_from date, p_to date) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT jsonb_build_object(
    'opening_kobo', coalesce(sum(CASE WHEN lower(l.line_type) = 'debit' THEN l.base_amount ELSE -l.base_amount END) FILTER (WHERE e.entry_date < p_from), 0)::bigint,
    'inflow_kobo',  coalesce(sum(l.base_amount) FILTER (WHERE lower(l.line_type) = 'debit'  AND e.entry_date BETWEEN p_from AND p_to), 0)::bigint,
    'outflow_kobo', coalesce(sum(l.base_amount) FILTER (WHERE lower(l.line_type) = 'credit' AND e.entry_date BETWEEN p_from AND p_to), 0)::bigint,
    'closing_kobo', coalesce(sum(CASE WHEN lower(l.line_type) = 'debit' THEN l.base_amount ELSE -l.base_amount END) FILTER (WHERE e.entry_date <= p_to), 0)::bigint)
  FROM coop_journal_entry_lines l
  JOIN coop_journal_entries e ON e.id = l.journal_entry_id
  JOIN coop_chart_of_accounts a ON a.id = l.account_id
  WHERE l.coop_id = p_coop_id AND a.account_code = p_account_code
$$;
REVOKE ALL ON FUNCTION coop_account_period_totals(text, text, date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION coop_account_period_totals(text, text, date, date) TO service_role;

-- The period each uploaded bank statement actually covers, per statement, for one bank account. Lets the monitor tell "this
-- Flutterwave payout is missing from a statement that SHOULD show it" apart from "no statement has been uploaded for that
-- period yet" - the two are very different things to a person watching their bank account.
CREATE OR REPLACE FUNCTION coop_bank_statement_coverage(p_coop_id text, p_bank_account_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.uploaded_at DESC), '[]'::jsonb) FROM (
    SELECT b.id AS batch_id, b.uploaded_at, b.filename, b.opening_balance_kobo, b.closing_balance_kobo,
           min(l.statement_date) AS from_date, max(l.statement_date) AS to_date, count(l.id) AS lines
    FROM coop_bank_reconciliation_batches b JOIN coop_bank_statement_lines l ON l.batch_id = b.id
    WHERE b.coop_id = p_coop_id AND b.bank_account_id = p_bank_account_id
    GROUP BY b.id) t
$$;
REVOKE ALL ON FUNCTION coop_bank_statement_coverage(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION coop_bank_statement_coverage(text, uuid) TO service_role;
