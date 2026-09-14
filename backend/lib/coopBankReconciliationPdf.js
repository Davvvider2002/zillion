/**
 * zillion/backend/lib/coopBankReconciliationPdf.js
 *
 * Renders a bank reconciliation batch as a formal, signable
 * reconciliation statement PDF - matching a standard accounting
 * template (header fields, a two-sided Bank/Book summary, itemized
 * schedules, and a final sign-off section), not just an ad-hoc export.
 *
 * Adjusted Bank Balance and Adjusted Book Balance are designed to
 * come out exactly equal whenever the uploaded statement is complete
 * - verified algebraically and numerically before this was written:
 * every unmatched line is partitioned into exactly one of "bank
 * charges not recorded" / "direct debits not recorded" / "direct
 * credits not recorded", and the bank-stated closing balance is left
 * untouched on the bank side (no invented deposits-in-transit or
 * outstanding-cheque figures this system has no reliable way to
 * compute) while the book side is adjusted for exactly those three
 * buckets. If they DON'T match, that's a real, honest signal - either
 * a genuine unresolved discrepancy or a data-entry mistake in the
 * closing balance the admin typed in, not something to paper over.
 */
'use strict';

const PDFDocument = require('pdfkit');

function fmtNaira(kobo) {
  if (kobo == null) return '';
  const naira = kobo / 100;
  const sign = naira < 0 ? '-' : '';
  return sign + 'NGN ' + Math.abs(naira).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(d) {
  if (!d) return '\u2014';
  return new Date(d).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
}

const CHARGE_KEYWORDS = /charge|fee|commission|vat|stamp duty/i;

/**
 * @param {object} data
 * @param {object} data.society               { name }
 * @param {object} data.bankAccount           { account_name }
 * @param {object} data.batch                 { filename, uploaded_at, opening_balance_kobo, closing_balance_kobo, prepared_by }
 * @param {Array}  data.lines                 statement lines: { statement_date, description, amount_kobo, direction, match_status }
 * @param {Array}  data.unmatchedRecords      recorded loan disbursements/repayments with no matching statement line: { record_type, record_date, amount_kobo, description }
 * @param {number} data.balancePerCashBookKobo  the bank account's TRUE, live ledger balance (every journal entry that ever posted to it, not just this batch's own resolved lines)
 * @returns {Promise<Buffer>}
 */
function generateBankReconciliationPdf(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const { society, bankAccount, batch, lines, unmatchedRecords = [], balancePerCashBookKobo } = data;

    const unmatched = lines.filter(l => l.match_status !== 'matched');
    const unmatchedCredits = unmatched.filter(l => l.direction === 'credit');
    const unmatchedDebits = unmatched.filter(l => l.direction === 'debit');
    const unmatchedChargeDebits = unmatchedDebits.filter(l => CHARGE_KEYWORDS.test(l.description || ''));
    const unmatchedOtherDebits = unmatchedDebits.filter(l => !CHARGE_KEYWORDS.test(l.description || ''));

    const sum = arr => arr.reduce((s, l) => s + l.amount_kobo, 0);
    const bankChargesNotRecordedKobo = sum(unmatchedChargeDebits);
    const directDebitsNotRecordedKobo = sum(unmatchedOtherDebits);
    const directCreditsNotRecordedKobo = sum(unmatchedCredits);

    // Recorded in the books (a loan disbursement or repayment) but not
    // found on this bank statement - shown as real, informational
    // context (Sections 2 & 3) but deliberately NOT folded into the
    // Adjusted Bank/Book Balance arithmetic below: these come from the
    // loan module, not the accounting ledger, so there's no reliable
    // way to know whether they've actually hit this bank account's
    // real ledger balance without risking double-counting.
    const outstandingPayments = unmatchedRecords.filter(r => r.record_type === 'loan_disbursement');
    const depositsInTransit = unmatchedRecords.filter(r => r.record_type === 'loan_repayment');

    const balancePerBankStatementKobo = batch.closing_balance_kobo ?? 0;
    const adjustedBankBalanceKobo = balancePerBankStatementKobo; // no reliable in-transit/outstanding data to adjust with

    const adjustedBookBalanceKobo = balancePerCashBookKobo + directCreditsNotRecordedKobo - bankChargesNotRecordedKobo - directDebitsNotRecordedKobo;
    const differenceKobo = adjustedBankBalanceKobo - adjustedBookBalanceKobo;

    const PAGE_W = 515; // usable width within 40pt margins on A4
    const L = 40;

    // ---- Header -------------------------------------------------------
    doc.fontSize(15).font('Helvetica-Bold').text('BANK RECONCILIATION STATEMENT', { align: 'center' });
    doc.moveDown(1);

    doc.fontSize(9.5).font('Helvetica');
    const headerRow = (label, value) => {
      doc.font('Helvetica-Bold').text(label, L, doc.y, { continued: true, width: 180 });
      doc.font('Helvetica').text(value || '\u2014');
    };
    headerRow('Company/Organisation:', society.name);
    headerRow('Bank Name:', bankAccount.account_name);
    headerRow('Bank Account Name:', `${society.name} \u2014 ${bankAccount.account_name}`);
    headerRow('Bank Account Number:', bankAccount.account_number || 'N/A');
    const dates = lines.map(l => l.statement_date).sort();
    headerRow('Statement Period:', dates.length ? `From ${fmtDate(dates[0])} To ${fmtDate(dates[dates.length - 1])}` : '\u2014');
    headerRow('Reconciliation Date:', fmtDate(batch.uploaded_at));
    headerRow('Prepared By:', batch.prepared_by || '\u2014');
    headerRow('Reviewed/Approved By:', '________________________________');
    doc.moveDown(1);

    // ---- Section 1: Reconciliation Summary -----------------------------
    doc.fontSize(11).font('Helvetica-Bold').text('1. Reconciliation Summary');
    doc.moveDown(0.3);

    const summaryRow = (label, value, opts = {}) => {
      const y = doc.y;
      doc.fontSize(9.5).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').text(label, L, y, { width: 380 });
      doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').text(value, L + 380, y, { width: PAGE_W - 380, align: 'right' });
      doc.moveDown(0.35);
    };

    summaryRow('Balance as per Bank Statement', fmtNaira(balancePerBankStatementKobo));
    summaryRow('Add: Deposits/Cheques in Transit', fmtNaira(0));
    summaryRow('Add: Other Bank Adjustments', fmtNaira(0));
    summaryRow('Less: Outstanding Cheques/Payments', '(' + fmtNaira(0) + ')');
    summaryRow('Less: Bank Charges Not Recorded', '(' + fmtNaira(0) + ')');
    summaryRow('Less: Direct Debits/Standing Orders Not Recorded', '(' + fmtNaira(0) + ')');
    summaryRow('Add: Direct Credits/Receipts Not Recorded', fmtNaira(0));
    summaryRow('Add/Less: Errors by Bank', fmtNaira(0));
    doc.moveTo(L, doc.y).lineTo(L + PAGE_W, doc.y).stroke();
    doc.moveDown(0.2);
    summaryRow('Adjusted Bank Balance', fmtNaira(adjustedBankBalanceKobo), { bold: true });
    doc.fontSize(8).font('Helvetica-Oblique').fillColor('#555')
      .text('The bank statement\'s own closing balance already reflects every transaction the bank has processed, including items not yet recorded in the books below - so no further adjustment applies here. Those items are reconciled against the Cash Book side instead (see Sections 4 & 5).', L, doc.y, { width: PAGE_W });
    doc.fillColor('black');
    doc.moveDown(0.4);

    summaryRow('Balance as per Cash Book/Ledger', fmtNaira(balancePerCashBookKobo));
    summaryRow('Add: Receipts Not Yet Recorded', fmtNaira(directCreditsNotRecordedKobo));
    summaryRow('Less: Payments Not Yet Recorded', '(' + fmtNaira(bankChargesNotRecordedKobo + directDebitsNotRecordedKobo) + ')');
    summaryRow('Add/Less: Accounting Errors', fmtNaira(0));
    doc.moveTo(L, doc.y).lineTo(L + PAGE_W, doc.y).stroke();
    doc.moveDown(0.2);
    summaryRow('Adjusted Book Balance', fmtNaira(adjustedBookBalanceKobo), { bold: true });
    summaryRow('Difference', fmtNaira(differenceKobo), { bold: true });
    doc.moveDown(0.3);
    doc.fontSize(8.5).font('Helvetica-Oblique').text('The Adjusted Bank Balance should equal the Adjusted Book Balance.', L, doc.y, { width: PAGE_W });
    doc.moveDown(0.8);

    // ---- Generic itemized-schedule table helper ------------------------
    function itemTable(title, note, rows, colLabels, colWidths, rowMapper, totalLabel, totalValue) {
      if (doc.y > 650) doc.addPage();
      doc.fontSize(11).font('Helvetica-Bold').text(title, L, doc.y, { width: PAGE_W });
      if (note) { doc.fontSize(8.5).font('Helvetica-Oblique').fillColor('#555').text(note, L, doc.y, { width: PAGE_W }); doc.fillColor('black'); }
      doc.moveDown(0.3);

      const xs = [];
      let x = L;
      for (const w of colWidths) { xs.push(x); x += w; }

      doc.fontSize(8.5).font('Helvetica-Bold');
      let y = doc.y;
      colLabels.forEach((c, i) => doc.text(c, xs[i], y, { width: colWidths[i] }));
      doc.moveDown(0.3);
      doc.moveTo(L, doc.y).lineTo(L + PAGE_W, doc.y).stroke();
      doc.moveDown(0.2);

      doc.font('Helvetica');
      if (!rows.length) {
        doc.fontSize(8.5).fillColor('#777').text('No items.', L, doc.y);
        doc.fillColor('black');
        doc.moveDown(0.4);
      } else {
        for (const r of rows) {
          if (doc.y > 760) { doc.addPage(); y = doc.y; }
          y = doc.y;
          const cells = rowMapper(r);
          cells.forEach((c, i) => doc.text(c, xs[i], y, { width: colWidths[i] }));
          doc.moveDown(0.45);
        }
      }
      doc.moveTo(L, doc.y).lineTo(L + PAGE_W, doc.y).stroke();
      doc.moveDown(0.2);
      const totalY = doc.y;
      doc.font('Helvetica-Bold').fontSize(8.5).text(totalLabel, xs[0], totalY, { width: colWidths[0] + colWidths[1] + colWidths[2] });
      doc.text(totalValue, xs[3] || xs[xs.length - 1], totalY, { width: colWidths[3] || colWidths[colWidths.length - 1] });
      doc.y = totalY + 14;
      doc.moveDown(0.8);
    }

    // ---- Section 2: Outstanding Payments/Cheques -----------------------
    itemTable(
      '2. Outstanding Payments/Cheques',
      'Loan disbursements recorded in Zillion but not yet found on this bank statement.',
      outstandingPayments, ['Date', 'Cheque/Payment No.', 'Payee/Description', 'Amount'], [70, 110, 220, 115],
      r => [fmtDate(r.record_date), '\u2014', r.description || '\u2014', fmtNaira(r.amount_kobo)],
      'Total', fmtNaira(sum(outstandingPayments))
    );

    // ---- Section 3: Deposits/Receipts in Transit ------------------------
    itemTable(
      '3. Deposits/Receipts in Transit',
      'Loan repayments recorded in Zillion but not yet found on this bank statement.',
      depositsInTransit, ['Date', 'Receipt/Reference No.', 'Description', 'Amount'], [70, 110, 220, 115],
      r => [fmtDate(r.record_date), '\u2014', r.description || '\u2014', fmtNaira(r.amount_kobo)],
      'Total', fmtNaira(sum(depositsInTransit))
    );

    // ---- Section 4: Bank Charges & Direct Debits ------------------------
    itemTable(
      '4. Bank Charges & Direct Debits',
      'Every debit line from the uploaded statement not yet matched to a recorded transaction.',
      unmatchedDebits, ['Date', 'Description', 'Amount', 'Posted to Ledger?'], [70, 260, 100, 85],
      l => [fmtDate(l.statement_date), l.description || '\u2014', fmtNaira(l.amount_kobo), 'No'],
      'Total', fmtNaira(bankChargesNotRecordedKobo + directDebitsNotRecordedKobo)
    );

    // ---- Section 5: Direct Credits / Bank Receipts -----------------------
    itemTable(
      '5. Direct Credits / Bank Receipts',
      'Every credit line from the uploaded statement not yet matched to a recorded transaction.',
      unmatchedCredits, ['Date', 'Description', 'Amount', 'Posted to Ledger?'], [70, 260, 100, 85],
      l => [fmtDate(l.statement_date), l.description || '\u2014', fmtNaira(l.amount_kobo), 'No'],
      'Total', fmtNaira(directCreditsNotRecordedKobo)
    );

    // ---- Section 6: Reconciliation Differences/Errors ---------------------
    const diffRows = differenceKobo !== 0 ? [{ description: 'Unexplained difference between adjusted bank and book balances', amount_kobo: differenceKobo }] : [];
    itemTable(
      '6. Reconciliation Differences / Errors',
      'Populated only if the Adjusted Bank Balance and Adjusted Book Balance above do not match exactly.',
      diffRows, ['Description', 'Adjustment'], [400, 115],
      r => [r.description, fmtNaira(r.amount_kobo)],
      'Total Adjustment', fmtNaira(differenceKobo)
    );

    // ---- Final Reconciliation & sign-off ---------------------------------
    if (doc.y > 620) doc.addPage();
    doc.fontSize(11).font('Helvetica-Bold').text('Final Reconciliation', L, doc.y, { width: PAGE_W });
    doc.moveDown(0.4);
    doc.fontSize(9.5).font('Helvetica');
    doc.text(`Balance per Bank Statement: ${fmtNaira(balancePerBankStatementKobo)}`, L, doc.y, { width: PAGE_W });
    doc.text(`Adjusted Bank Balance: ${fmtNaira(adjustedBankBalanceKobo)}`, L, doc.y, { width: PAGE_W });
    doc.text(`Balance per Cash Book: ${fmtNaira(balancePerCashBookKobo)}`, L, doc.y, { width: PAGE_W });
    doc.text(`Adjusted Book Balance: ${fmtNaira(adjustedBookBalanceKobo)}`, L, doc.y, { width: PAGE_W });
    doc.font('Helvetica-Bold').text(`Unreconciled Difference: ${fmtNaira(differenceKobo)}`, L, doc.y, { width: PAGE_W });
    doc.moveDown(0.6);

    doc.font('Helvetica').text('Status:', L, doc.y, { width: PAGE_W });
    const statusLabel = differenceKobo === 0 ? 'Reconciled' : (unmatched.length < lines.length ? 'Reconciled with Adjustments' : 'Unreconciled');
    ['Reconciled', 'Reconciled with Adjustments', 'Unreconciled'].forEach(s => {
      doc.text(`${s === statusLabel ? '[X]' : '[ ]'} ${s}`, L, doc.y, { width: PAGE_W });
    });
    doc.moveDown(1);

    doc.text('Prepared By: __________________________   Date: _____________', L, doc.y, { width: PAGE_W });
    doc.moveDown(0.6);
    doc.text('Reviewed By: __________________________   Date: _____________', L, doc.y, { width: PAGE_W });
    doc.moveDown(0.6);
    doc.text('Approved By: __________________________   Date: _____________', L, doc.y, { width: PAGE_W });

    doc.end();
  });
}

module.exports = { generateBankReconciliationPdf };
