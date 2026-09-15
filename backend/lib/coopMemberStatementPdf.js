/**
 * zillion/backend/lib/coopMemberStatementPdf.js
 *
 * Renders one member's complete statement (from computeMemberFullStatement)
 * as a PDF buffer - savings, loans, investment, and dues, each as its
 * own section with a chronological transaction list and running
 * balance, matching the level of detail the loan section already had.
 *
 * Uses "NGN " rather than the \u20a6 naira glyph - confirmed by direct
 * rendering test that standard PDF fonts (Helvetica) don't support
 * that character at all, silently producing a broken "\u00a6" symbol.
 * The previous loan-only statement PDF had this exact bug live; fixed
 * here rather than carried forward.
 */
'use strict';

const PDFDocument = require('pdfkit');

function fmtNaira(kobo) {
  if (kobo == null) return 'NGN 0';
  const naira = Math.round(kobo) / 100;
  const sign = naira < 0 ? '-' : '';
  return sign + 'NGN ' + Math.abs(naira).toLocaleString();
}
function fmtDate(iso) { return iso ? new Date(iso).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }) : '\u2014'; }

/**
 * @param {object} statementData  from computeMemberFullStatement
 * @returns {Promise<Buffer>}
 */
function generateMemberStatementPdf(statementData) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 45 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const { member, savings, loans, investment, dues } = statementData;
    const L = 45, PAGE_R = 550;

    doc.fontSize(16).font('Helvetica-Bold').text('Zillion Coop \u2014 Member Statement', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(10).font('Helvetica').text(`Member: ${member.name}   |   ${member.phone}`);
    doc.text(`Society: ${member.society_name}`);
    doc.text(`Statement date: ${fmtDate(new Date().toISOString())}`);
    doc.moveDown(1);

    // ---- Shared transaction-table renderer, used by every section ------
    function transactionTable(transactions) {
      const colX = [L, 150, 350, 420, 490];
      doc.fontSize(9).font('Helvetica-Bold');
      const headerY = doc.y;
      doc.text('Date', colX[0], headerY);
      doc.text('Description', colX[1], headerY);
      doc.text('Debit', colX[2], headerY);
      doc.text('Credit', colX[3], headerY);
      doc.text('Balance', colX[4], headerY);
      doc.moveDown(0.3);
      doc.moveTo(L, doc.y).lineTo(PAGE_R, doc.y).stroke();
      doc.moveDown(0.3);

      doc.font('Helvetica');
      for (const t of transactions) {
        if (doc.y > 760) { doc.addPage(); doc.moveDown(0.5); }
        const rowY = doc.y;
        const descHeight = doc.heightOfString(t.description, { width: 190 });
        doc.text(fmtDate(t.date), colX[0], rowY);
        doc.text(t.description, colX[1], rowY, { width: 190 });
        doc.text(t.debit_kobo ? fmtNaira(t.debit_kobo) : '', colX[2], rowY);
        doc.text(t.credit_kobo ? fmtNaira(t.credit_kobo) : '', colX[3], rowY);
        doc.text(fmtNaira(t.balance_kobo), colX[4], rowY);
        doc.y = rowY + Math.max(descHeight, 12) + 4;
      }
    }

    function sectionHeading(title) {
      if (doc.y > 700) doc.addPage();
      doc.moveDown(0.4);
      doc.fontSize(13).font('Helvetica-Bold').fillColor('#1a5c38').text(title, L, doc.y, { width: PAGE_R - L });
      doc.fillColor('black');
      doc.moveDown(0.3);
    }

    // ---- 1. Savings ------------------------------------------------------
    sectionHeading('1. Savings');
    if (!savings.length) {
      doc.fontSize(10).font('Helvetica').text('No savings plans.');
    }
    for (const plan of savings) {
      if (doc.y > 680) doc.addPage();
      doc.fontSize(11).font('Helvetica-Bold').text(
        `Savings plan${plan.target_amount_kobo ? ` \u2014 target ${fmtNaira(plan.target_amount_kobo)}` : ''}`
      );
      doc.fontSize(9).font('Helvetica').text(`Current balance: ${fmtNaira(plan.saved_kobo)}   |   Status: ${plan.status}`);
      doc.moveDown(0.4);
      if (plan.transactions.length) transactionTable(plan.transactions);
      else doc.fontSize(9).font('Helvetica-Oblique').text('No transactions yet.');
      doc.moveDown(1);
    }

    // ---- 2. Loans ----------------------------------------------------------
    sectionHeading('2. Loans');
    const activeLoans = loans.filter(l => l.transactions && l.transactions.length);
    if (!activeLoans.length) {
      doc.fontSize(10).font('Helvetica').text('No loan activity.');
    }
    for (const loan of activeLoans) {
      if (doc.y > 680) doc.addPage();
      doc.fontSize(11).font('Helvetica-Bold').text(
        `Loan \u2014 ${fmtNaira(loan.principal_kobo)} principal${loan.interest_kobo > 0 ? ` + ${loan.interest_rate_percent}% interest` : ''}`
      );
      doc.fontSize(9).font('Helvetica').text(
        `Total repayable: ${fmtNaira(loan.total_repayable_kobo)}   |   Paid: ${fmtNaira(loan.total_paid_kobo)}   |   Outstanding: ${fmtNaira(loan.outstanding_kobo)}   |   Status: ${loan.status}`
      );
      doc.moveDown(0.4);
      transactionTable(loan.transactions);
      if (loan.upcoming_schedule && loan.upcoming_schedule.length) {
        doc.moveDown(0.3);
        doc.fontSize(9).font('Helvetica-Oblique').text(
          `Next due: ${fmtDate(loan.upcoming_schedule[0].due_date)} \u2014 ${fmtNaira(loan.upcoming_schedule[0].amount_due_kobo)}`
        );
      }
      doc.moveDown(1);
    }

    // ---- 3. Investment -------------------------------------------------------
    sectionHeading('3. Investment');
    if (!investment.length) {
      doc.fontSize(10).font('Helvetica').text('No investment activity.');
    }
    for (const inv of investment) {
      if (doc.y > 680) doc.addPage();
      doc.fontSize(11).font('Helvetica-Bold').text(
        `${inv.product_name} \u2014 ${fmtNaira(inv.principal_kobo)} principal (${inv.units_purchased} unit${inv.units_purchased === 1 ? '' : 's'})`
      );
      doc.fontSize(9).font('Helvetica').text(
        `Current value: ${fmtNaira(inv.current_value_kobo)}   |   Maturity: ${fmtDate(inv.maturity_date)}   |   Status: ${inv.status}`
      );
      doc.moveDown(0.4);
      transactionTable(inv.transactions);
      doc.moveDown(1);
    }

    // ---- 4. Dues ---------------------------------------------------------
    sectionHeading('4. Dues');
    if (!dues.summary) {
      doc.fontSize(10).font('Helvetica').text('Dues are not configured for this society.');
    } else {
      if (doc.y > 680) doc.addPage();
      doc.fontSize(9).font('Helvetica').text(
        `Total accrued: ${fmtNaira(dues.summary.total_accrued_kobo)}   |   Total paid: ${fmtNaira(dues.summary.total_paid_kobo)}   |   Owing: ${fmtNaira(dues.summary.owing_kobo)}`
      );
      doc.moveDown(0.3);
      doc.fontSize(8.5).font('Helvetica-Bold').text('By year:');
      doc.font('Helvetica');
      for (const y of dues.summary.by_year) {
        doc.text(`  ${y.year}: accrued ${fmtNaira(y.accrued_kobo)}, paid ${fmtNaira(y.paid_kobo)}, owing ${fmtNaira(y.owing_kobo)}`);
      }
      doc.moveDown(0.5);
      if (dues.transactions.length) transactionTable(dues.transactions);
      else doc.fontSize(9).font('Helvetica-Oblique').text('No dues payments recorded yet.');
    }

    doc.end();
  });
}

module.exports = { generateMemberStatementPdf };
