/**
 * zillion/backend/lib/coopPayslipPdf.js
 *
 * One employee's payslip for one payroll run - the document that
 * genuinely didn't exist before: the payroll breakdown modal shows
 * every employee in one table for the admin's own review, but no
 * individual, employee-facing payslip was ever generated for anyone
 * to actually receive.
 *
 * Uses "NGN" rather than the naira glyph, same fix as the other PDF
 * generators this session - standard PDF fonts don't render it.
 */
'use strict';

const PDFDocument = require('pdfkit');

function fmtNaira(kobo) {
  if (kobo == null) return 'NGN 0.00';
  const naira = Math.round(kobo) / 100;
  const sign = naira < 0 ? '-' : '';
  return sign + 'NGN ' + Math.abs(naira).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(iso) { return iso ? new Date(iso).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }) : '\u2014'; }

/**
 * @param {object} data
 * @param {object} data.society    { name }
 * @param {object} data.employee   { name, job_title, bank_name, bank_account_number, tin, pension_rsa_number }
 * @param {object} data.run        { period_label, period_start, period_end, processed_at }
 * @param {object} data.line       { basic_salary_kobo, gross_pay_kobo, paye_kobo, pension_employee_kobo, pension_employer_kobo, nhf_kobo, nsitf_kobo, staff_loan_deduction_kobo, net_pay_kobo }
 * @returns {Promise<Buffer>}
 */
function generatePayslipPdf(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 45 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const { society, employee, run, line } = data;
    const L = 45, PAGE_R = 550;

    doc.fontSize(16).font('Helvetica-Bold').text(society.name, { align: 'center' });
    doc.fontSize(12).font('Helvetica').text('Payslip', { align: 'center' });
    doc.moveDown(0.8);
    doc.moveTo(L, doc.y).lineTo(PAGE_R, doc.y).stroke();
    doc.moveDown(0.6);

    doc.fontSize(10).font('Helvetica-Bold').text('Employee: ', L, doc.y, { continued: true, width: 200 });
    doc.font('Helvetica').text(employee.name);
    doc.font('Helvetica-Bold').text('Role: ', L, doc.y, { continued: true, width: 200 });
    doc.font('Helvetica').text(employee.job_title || '\u2014');
    doc.font('Helvetica-Bold').text('Pay period: ', L, doc.y, { continued: true, width: 200 });
    doc.font('Helvetica').text(`${run.period_label} (${fmtDate(run.period_start)} \u2013 ${fmtDate(run.period_end)})`);
    doc.font('Helvetica-Bold').text('Paid on: ', L, doc.y, { continued: true, width: 200 });
    doc.font('Helvetica').text(fmtDate(run.processed_at));
    if (employee.bank_name || employee.bank_account_number) {
      doc.font('Helvetica-Bold').text('Bank: ', L, doc.y, { continued: true, width: 200 });
      doc.font('Helvetica').text(`${employee.bank_name || ''} ${employee.bank_account_number || ''}`.trim());
    }
    if (employee.pension_rsa_number) {
      doc.font('Helvetica-Bold').text('Pension RSA: ', L, doc.y, { continued: true, width: 200 });
      doc.font('Helvetica').text(employee.pension_rsa_number);
    }
    doc.moveDown(0.8);

    function row(label, amount, opts = {}) {
      const y = doc.y;
      doc.fontSize(10).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').text(label, L, y, { width: 350 });
      doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').text(amount, L + 350, y, { width: PAGE_R - L - 350, align: 'right' });
      doc.moveDown(0.45);
    }

    doc.fontSize(11).font('Helvetica-Bold').text('Earnings', L, doc.y, { width: PAGE_R - L });
    doc.moveDown(0.3);
    row('Basic salary', fmtNaira(line.basic_salary_kobo));
    row('Allowances', fmtNaira(line.gross_pay_kobo - line.basic_salary_kobo));
    doc.moveTo(L, doc.y).lineTo(PAGE_R, doc.y).stroke();
    doc.moveDown(0.2);
    row('Gross pay', fmtNaira(line.gross_pay_kobo), { bold: true });
    doc.moveDown(0.5);

    doc.fontSize(11).font('Helvetica-Bold').text('Deductions', L, doc.y, { width: PAGE_R - L });
    doc.moveDown(0.3);
    row('PAYE (tax)', '(' + fmtNaira(line.paye_kobo) + ')');
    row('Pension (employee)', '(' + fmtNaira(line.pension_employee_kobo) + ')');
    if (line.nhf_kobo > 0) row('NHF', '(' + fmtNaira(line.nhf_kobo) + ')');
    if (line.nsitf_kobo > 0) row('NSITF', '(' + fmtNaira(line.nsitf_kobo) + ')');
    if (line.staff_loan_deduction_kobo > 0) row('Staff loan repayment', '(' + fmtNaira(line.staff_loan_deduction_kobo) + ')');
    doc.moveTo(L, doc.y).lineTo(PAGE_R, doc.y).stroke();
    doc.moveDown(0.4);

    doc.fontSize(13).font('Helvetica-Bold').fillColor('#1a5c38');
    row('Net pay', fmtNaira(line.net_pay_kobo), { bold: true });
    doc.fillColor('black');
    doc.moveDown(0.3);
    doc.fontSize(8).font('Helvetica-Oblique').text(`Employer pension contribution of ${fmtNaira(line.pension_employer_kobo)} is paid by ${society.name} on top of gross pay and is not deducted from this payslip.`, L, doc.y, { width: PAGE_R - L });

    doc.moveDown(1.5);
    doc.fontSize(8).font('Helvetica-Oblique').fillColor('#666').text('This is a system-generated payslip and does not require a signature.', L, doc.y, { width: PAGE_R - L });

    doc.end();
  });
}

module.exports = { generatePayslipPdf };
