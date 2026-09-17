/**
 * zillion/backend/netlify/functions/coop-portal-send-payslip.js
 *
 * POST /api/v1/coop-portal-send-payslip
 * Body: { payroll_run_id, employee_id, action: 'download' | 'email' }
 *
 * download: generates the payslip and returns it base64-encoded, for
 * a direct browser download (and the source PDF a WhatsApp share
 * button hands off to, since there is no WhatsApp Business API
 * integration in this codebase to send a file programmatically -
 * only a wa.me deep link that opens a chat with the employee's
 * number, which the frontend builds itself once this download
 * succeeds).
 *
 * email: same PDF, sent as an attachment to the employee's own email
 * on file. Fails clearly if there is none, rather than silently
 * doing nothing.
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');
const { generatePayslipPdf }   = require('../../lib/coopPayslipPdf');
const { sendEmail }            = require('../../lib/resendEmail');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');

  const db = getServiceClient();
  const resolved = await resolvePortalSociety(db, auth);
  if (!resolved.ok) return err(resolved.status, resolved.error);
  const coopId = resolved.society.coop_id;

  if (!(await requirePortalPermission(db, auth, 'hr_payroll', 'view'))) {
    return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const { payroll_run_id: payrollRunId, employee_id: employeeId, action } = body;
  if (!payrollRunId) return err(400, 'payroll_run_id is required');
  if (!employeeId) return err(400, 'employee_id is required');
  if (!['download', 'email'].includes(action)) return err(400, "action must be 'download' or 'email'");

  const { data: run } = await db.from('coop_payroll_runs')
    .select('id, period_label, period_start, period_end, processed_at').eq('id', payrollRunId).eq('coop_id', coopId).maybeSingle();
  if (!run) return err(404, 'Payroll run not found in your society');

  const { data: line } = await db.from('coop_payroll_run_lines')
    .select('*').eq('payroll_run_id', payrollRunId).eq('employee_id', employeeId).maybeSingle();
  if (!line) return err(404, 'No payslip line for this employee on this payroll run');

  const { data: employee } = await db.from('coop_employees')
    .select('name, job_title, email, bank_name, bank_account_number, pension_rsa_number').eq('id', employeeId).eq('coop_id', coopId).maybeSingle();
  if (!employee) return err(404, 'Employee not found in your society');

  const pdfBuffer = await generatePayslipPdf({ society: { name: resolved.society.name }, employee, run, line });

  if (action === 'download') {
    return ok({ success: true, filename: `payslip-${(employee.name || 'employee').replace(/\s+/g, '-').toLowerCase()}-${run.period_label.replace(/\s+/g, '-').toLowerCase()}.pdf`, pdf_base64: pdfBuffer.toString('base64') });
  }

  // action === 'email'
  if (!employee.email) return err(400, `${employee.name} has no email on file — add one before sending a payslip by email.`);

  const result = await sendEmail({
    to: employee.email,
    toName: employee.name,
    subject: `Your payslip — ${run.period_label}`,
    htmlContent: `<p>Hi ${employee.name},</p><p>Your payslip for ${run.period_label} is attached.</p>`,
    attachments: [{ filename: 'payslip.pdf', content: pdfBuffer.toString('base64') }],
  });

  if (!result.sent) return err(500, result.reason === 'not_configured' ? 'Email sending is not yet configured for this platform.' : 'Failed to send email — please try again.');

  return ok({ success: true, sent_to: employee.email });
};
