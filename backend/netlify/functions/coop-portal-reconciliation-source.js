/**
 * zillion/backend/netlify/functions/coop-portal-reconciliation-source.js
 *
 * GET /api/v1/coop-portal-reconciliation-source?type=loan_disbursement|loan_repayment&id=<uuid>
 *
 * A matched bank reconciliation line already carries matched_type and
 * matched_id (computed in coopBankReconciliation.js and persisted on
 * the line) - this endpoint is what lets "view where the transaction
 * was initiated" actually show something, by resolving that reference
 * back to the real loan or repayment record it points to.
 *
 * Gated behind the same 'reconciliation' permission as the rest of
 * bank reconciliation, and behind the add-on itself.
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');
const { hasAddon }             = require('../../lib/coopEntitlements');
const { fetchAllRows }         = require('../../lib/coopPaginate');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');

  const db = getServiceClient();
  const resolved = await resolvePortalSociety(db, auth);
  if (!resolved.ok) return err(resolved.status, resolved.error);
  const coopId = resolved.society.coop_id;

  if (!(await requirePortalPermission(db, auth, 'reconciliation'))) {
    return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');
  }
  if (!(await hasAddon(db, coopId, 'bank_reconciliation'))) return err(403, 'Bank Reconciliation is not on your current plan');

  const { type, id } = event.queryStringParameters || {};
  if (!type || !id) return err(400, 'type and id query params are required');

  if (type === 'loan_disbursement') {
    const { data: loan } = await db.from('coop_loans')
      .select('id, principal_kobo, disbursed_at, status, repayment_period_months, interest_method, coop_members!coop_loans_member_id_fkey(name, phone_normalized)')
      .eq('id', id).eq('coop_id', coopId).maybeSingle();
    if (!loan) return err(404, 'Loan not found in your society');
    return ok({
      type: 'loan_disbursement',
      member_name: loan.coop_members?.name || loan.coop_members?.phone_normalized || 'Unknown',
      principal_kobo: loan.principal_kobo,
      date: loan.disbursed_at,
      status: loan.status,
      repayment_period_months: loan.repayment_period_months,
      interest_method: loan.interest_method,
      loan_id: loan.id,
    });
  }

  if (type === 'loan_repayment') {
    const { data: repayment } = await db.from('coop_loan_repayments')
      .select('id, amount_kobo, recorded_at, source, loan_id, principal_portion_kobo, interest_portion_kobo, coop_loans!inner(coop_id, coop_members!coop_loans_member_id_fkey(name, phone_normalized))')
      .eq('id', id).eq('coop_loans.coop_id', coopId).maybeSingle();
    if (!repayment) return err(404, 'Repayment not found in your society');
    return ok({
      type: 'loan_repayment',
      member_name: repayment.coop_loans?.coop_members?.name || repayment.coop_loans?.coop_members?.phone_normalized || 'Unknown',
      amount_kobo: repayment.amount_kobo,
      date: repayment.recorded_at,
      source: repayment.source,
      principal_portion_kobo: repayment.principal_portion_kobo,
      interest_portion_kobo: repayment.interest_portion_kobo,
      loan_id: repayment.loan_id,
    });
  }

  if (type === 'journal_entry') {   // id is the journal LINE that was matched (an entry can touch the bank account twice)
    const { data: line } = await db.from('coop_journal_entry_lines').select('id, journal_entry_id').eq('id', id).eq('coop_id', coopId).maybeSingle();
    if (!line) return err(404, 'Entry not found in your society');
    const { data: entry } = await db.from('coop_journal_entries').select('id, entry_number, entry_date, description, entry_type, created_by').eq('id', line.journal_entry_id).eq('coop_id', coopId).maybeSingle();
    if (!entry) return err(404, 'Entry not found in your society');
    const lines = await fetchAllRows(() => db.from('coop_journal_entry_lines').select('account_id, line_type, amount').eq('journal_entry_id', entry.id).order('id'));
    const accounts = await fetchAllRows(() => db.from('coop_chart_of_accounts').select('id, account_code, account_name').eq('coop_id', coopId).order('id'));
    const byId = new Map(accounts.map(a => [a.id, a]));
    return ok({
      type: 'journal_entry', entry_number: entry.entry_number, date: entry.entry_date, description: entry.description, entry_type: entry.entry_type, created_by: entry.created_by,
      lines: lines.map(l => ({ account_code: (byId.get(l.account_id) || {}).account_code, account_name: (byId.get(l.account_id) || {}).account_name, side: String(l.line_type).toLowerCase() === 'debit' ? 'Dr' : 'Cr', amount_kobo: Number(l.amount) })),
    });
  }

  if (type === 'flutterwave_settlement') {
    const { data: row } = await db.from('coop_flutterwave_ledger')
      .select('id, amount_kobo, fees_kobo, occurred_at, flw_settlement_id, purpose, match_status, expected_kobo, variance_kobo, settlement_account_number, account_matches, journal_entry_id')
      .eq('id', id).eq('coop_id', coopId).eq('entry_type', 'SETTLEMENT').maybeSingle();
    if (!row) return err(404, 'Flutterwave settlement not found in your society');
    const covered = await fetchAllRows(() => db.from('coop_flutterwave_ledger')
      .select('amount_kobo, purpose, counterparty_name, flw_tx_ref, occurred_at').eq('coop_id', coopId).eq('entry_type', 'PAYMENT').eq('settled_in', row.flw_settlement_id).order('occurred_at').order('id'));
    return ok({
      type: 'flutterwave_settlement', source: row.purpose === 'zillion_payout' ? 'Zillion payout' : 'Flutterwave settlement', settlement_ref: row.flw_settlement_id,
      date: row.occurred_at, amount_kobo: row.amount_kobo, fees_kobo: row.fees_kobo || 0, paid_to_bank_kobo: row.amount_kobo - (row.fees_kobo || 0),
      match_status: row.match_status, expected_kobo: row.expected_kobo, variance_kobo: row.variance_kobo, destination_account: row.settlement_account_number, account_matches: row.account_matches,
      journal_entry_id: row.journal_entry_id, payments: covered,
    });
  }

  return err(400, `Unknown type "${type}". Use: loan_disbursement, loan_repayment, flutterwave_settlement, journal_entry`);
};
