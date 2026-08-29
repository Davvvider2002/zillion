/**
 * zillion/backend/lib/coopLoanStatementPdf.js
 *
 * Renders one member's loan statement (from computeMemberLoanStatement)
 * as a PDF buffer, ready to attach to an email. Layout tested locally
 * with realistic sample data before this was written — confirmed a
 * valid PDF (correct magic bytes, sensible layout) before being wired
 * into anything that actually sends email.
 */
'use strict';

const PDFDocument = require('pdfkit');

function fmtNaira(kobo) { return '\u20a6' + Math.round((kobo || 0) / 100).toLocaleString(); }
function fmtDate(iso) { return iso ? new Date(iso).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }) : '\u2014'; }

/**
 * @param {object} statementData  from computeMemberLoanStatement
 * @returns {Promise<Buffer>}
 */
function generateLoanStatementPdf(statementData) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 45 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const { member, loans } = statementData;

    doc.fontSize(16).font('Helvetica-Bold').text('Zillion Coop \u2014 Loan Statement', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(10).font('Helvetica').text(`Member: ${member.name}   |   ${member.phone}`);
    doc.text(`Society: ${member.society_name}`);
    doc.text(`Statement date: ${fmtDate(new Date().toISOString())}`);
    doc.moveDown(1);

    const activeLoans = loans.filter(l => l.transactions && l.transactions.length);

    if (!activeLoans.length) {
      doc.fontSize(11).text('No loan activity to report.');
    }

    for (const loan of activeLoans) {
      // A new loan section starting too close to the bottom of the page
      // would look broken (header with no room for any rows under it).
      if (doc.y > 680) doc.addPage();

      doc.fontSize(12).font('Helvetica-Bold').text(
        `Loan \u2014 ${fmtNaira(loan.principal_kobo)} principal${loan.interest_kobo > 0 ? ` + ${loan.interest_rate_percent}% interest` : ''}`
      );
      doc.fontSize(9).font('Helvetica').text(
        `Total repayable: ${fmtNaira(loan.total_repayable_kobo)}   |   Paid: ${fmtNaira(loan.total_paid_kobo)}   |   Outstanding: ${fmtNaira(loan.outstanding_kobo)}   |   Status: ${loan.status}`
      );
      doc.moveDown(0.5);

      const colX = [45, 150, 350, 420, 490];
      doc.fontSize(9).font('Helvetica-Bold');
      const headerY = doc.y;
      doc.text('Date', colX[0], headerY);
      doc.text('Description', colX[1], headerY);
      doc.text('Debit', colX[2], headerY);
      doc.text('Credit', colX[3], headerY);
      doc.text('Balance', colX[4], headerY);
      doc.moveDown(0.3);
      doc.moveTo(45, doc.y).lineTo(550, doc.y).stroke();
      doc.moveDown(0.3);

      doc.font('Helvetica');
      for (const t of loan.transactions) {
        if (doc.y > 760) { doc.addPage(); doc.moveDown(0.5); }
        const rowY = doc.y;
        doc.text(fmtDate(t.date), colX[0], rowY);
        doc.text(t.description, colX[1], rowY, { width: 190 });
        doc.text(t.debit_kobo ? fmtNaira(t.debit_kobo) : '', colX[2], rowY);
        doc.text(t.credit_kobo ? fmtNaira(t.credit_kobo) : '', colX[3], rowY);
        doc.text(fmtNaira(t.balance_kobo), colX[4], rowY);
        doc.moveDown(0.6);
      }

      if (loan.upcoming_schedule && loan.upcoming_schedule.length) {
        doc.moveDown(0.4);
        doc.fontSize(9).font('Helvetica-Oblique').text(
          `Next due: ${fmtDate(loan.upcoming_schedule[0].due_date)} \u2014 ${fmtNaira(loan.upcoming_schedule[0].amount_due_kobo)}`
        );
      }
      doc.moveDown(1.2);
    }

    doc.end();
  });
}

module.exports = { generateLoanStatementPdf };
