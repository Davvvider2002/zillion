/**
 * zillion/backend/netlify/functions/coop-loans-admin.js
 *
 * GET  /api/v1/coop-loans-admin?coop_id=X&status=Y   — list loans
 * POST /api/v1/coop-loans-admin                       — approve / reject / disburse
 *
 * Auth: SUPER_ADMIN or OPERATIONS.
 *
 * NOTE on disbursement: this only RECORDS that disbursement happened —
 * it does not move any money itself. For the pilot, disbursement is a
 * manual transfer the society makes through their own bank app (or a
 * Zillion Merchant Send Zil transaction), confirmed here afterward.
 * Automatic webhook-confirmed disbursement is a planned later step
 * once the Moniepoint/OPay integration is live, not built here.
 */
'use strict';

const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { auditLog }               = require('../../lib/auditLog');
const { generateRepaymentSchedule } = require('../../lib/coopRepaymentSchedule');
const { recordLoanDisbursementJournalEntry } = require('../../lib/coopLoanAccounting');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');

  const db = getServiceClient();

  if (event.httpMethod === 'GET') {
    if (!requireRole(auth, ['SUPER_ADMIN','COMPLIANCE','OPERATIONS','SUPPORT','AUDITOR','VIEWER']))
      return err(403, 'Admin access required');

    const q = event.queryStringParameters || {};
    let query = db.from('coop_loans').select(`
      id, coop_id, member_id, principal_kobo, repayment_months, monthly_repayment_kobo,
      guarantor_member_id, guarantor_status, status, requested_at, approved_at, disbursed_at, rejection_reason,
      coop_members!coop_loans_member_id_fkey(name, phone_normalized),
      guarantor:coop_members!coop_loans_guarantor_member_id_fkey(name, phone_normalized)
    `).order('requested_at', { ascending: false });

    if (q.coop_id) query = query.eq('coop_id', q.coop_id);
    if (q.status)  query = query.eq('status', q.status);

    const { data, error } = await query;
    if (error) return err(500, error.message);
    return ok({ loans: data || [] });
  }

  if (event.httpMethod === 'POST') {
    if (!requireRole(auth, ['SUPER_ADMIN','OPERATIONS']))
      return err(403, 'SUPER_ADMIN or OPERATIONS role required to act on loans');

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return err(400, 'Invalid JSON'); }

    const loanId = (body.loan_id || '').trim();
    const action = (body.action || '').trim();
    if (!loanId) return err(400, 'loan_id is required');
    if (!['approve', 'reject', 'disburse'].includes(action))
      return err(400, 'action must be approve, reject, or disburse');

    const { data: loan } = await db.from('coop_loans').select('*').eq('id', loanId).maybeSingle();
    if (!loan) return err(404, 'Loan not found');

    const now = new Date().toISOString();
    const adminName = auth.payload.username || auth.payload.sub;
    let update;

    if (action === 'approve') {
      if (loan.status !== 'PENDING_APPROVAL')
        return err(409, `Loan must be PENDING_APPROVAL to approve (currently: ${loan.status})`);
      update = { status: 'APPROVED', approved_at: now, approved_by: adminName };
    } else if (action === 'reject') {
      if (['DISBURSED', 'REPAYING', 'COMPLETED'].includes(loan.status))
        return err(409, `Cannot reject a loan that's already disbursed (status: ${loan.status})`);
      update = { status: 'REJECTED', rejection_reason: (body.reason || '').trim() || `Rejected by ${adminName}` };
    } else if (action === 'disburse') {
      if (loan.status !== 'APPROVED')
        return err(409, `Loan must be APPROVED before it can be disbursed (currently: ${loan.status})`);
      update = { status: 'DISBURSED', disbursed_at: now };
    }

    const { data: updated, error: updateErr } = await db.from('coop_loans')
      .update(update).eq('id', loanId).select().single();
    if (updateErr) return err(500, `Failed to update loan: ${updateErr.message}`);

    // Generate the repayment schedule right when disbursement happens —
    // without this, there'd be a real disbursed loan with no way to
    // ever track it being paid back.
    if (action === 'disburse') {
      const schedule = generateRepaymentSchedule(loan.total_repayable_kobo, loan.repayment_months, now);
      const { error: scheduleErr } = await db.from('coop_loan_repayment_schedule').insert(
        schedule.map(p => ({ loan_id: loanId, ...p }))
      );
      if (scheduleErr) console.error('[coop-loans-admin] Schedule generation failed:', scheduleErr.message);
      // Non-fatal by design — disbursement itself already succeeded and
      // real money already moved (or is about to, via the admin's own
      // bank transfer); failing the whole request over a schedule
      // insert error would be worse than a loan that needs its
      // schedule regenerated manually.

      await recordLoanDisbursementJournalEntry(db, loan.coop_id, loan.principal_kobo, `admin:${adminName}`, loan.interest_kobo);
    }

    await auditLog(db, {
      action:       `COOP_LOAN_${action.toUpperCase()}D`,
      username:     adminName,
      role:         auth.payload.role,
      ip:           event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
      resourceType: 'coop_loan',
      resourceId:   loanId,
      requestBody:  { loan_id: loanId, action, reason: body.reason || null },
      result:       'SUCCESS',
    });

    return ok({ success: true, loan: updated });
  }

  return err(405, 'Method Not Allowed');
};
