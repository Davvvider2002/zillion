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

  return err(400, `Unknown type "${type}". Use: loan_disbursement, loan_repayment`);
};
