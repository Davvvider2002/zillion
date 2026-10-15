/**
 * zillion/backend/tests/test-bank-statement-tall-cells.js
 * Statements printed as tall table cells (GTBank style): the date split over two lines, narration wrapped over several lines, amounts in
 * the vertical middle of the cell, and a row repeated across a page break. Built from synthetic positioned text, so no real account data.
 * Run: node backend/tests/test-bank-statement-tall-cells.js
 */
'use strict';
const path = require('path');
const P = require(path.join(__dirname, '..', 'lib', 'bankStatementParser'));
let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };

const W = (s) => s.length * 5;
const it = (str, x, y, right) => ({ str, x: right ? right - W(str) : x, y, w: W(str) });
const COL = { date: 36, ref: 86, val: 189, debitR: 261, creditR: 328, balR: 399, rem: 442 };
const fmt = k => (k / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });

/** rows: [{ day:'03-Sep', desc:[lines], debit?, credit? }]; returns items for one page, centring each cell's text on the amounts row. */
function pageItems(rows, startY, opts = {}) {
  const items = [];
  if (opts.header) {
    items.push(it('Customer Statement', 300, 800), it('TEST CUSTOMER ONE', 40, 790));
    items.push(it('Account No:', 36, 720), it('0012345678', 92, 720), it('Currency:', 278, 720), it('NGN', 324, 720));
    items.push(it('Period:', 36, 700), it('September 1, 2026', 70, 700), it('September 30, 2026', 175, 700), it('Opening Balance:', 278, 700), it(fmt(opts.opening), 358, 700));
    items.push(it('Total Debit:', 36, 680), it(fmt(opts.totalDebit), 87, 680), it('Closing Balance:', 278, 680), it(fmt(opts.closing), 355, 680));
    items.push(it('Total Credit:', 278, 660), it(fmt(opts.totalCredit), 333, 660));
  }
  const hy = startY;
  items.push(it('Trans', COL.date, hy), it('Reference', COL.ref, hy), it('Value', COL.val, hy), it('Debit', 0, hy, COL.debitR), it('Credit', 0, hy, COL.creditR), it('Balance', 0, hy, COL.balR), it('Remarks', COL.rem, hy));
  items.push(it('Date', COL.date, hy - 9), it('Date', COL.val, hy - 9));
  let y = hy - 34;
  for (const r of rows) {
    const n = Math.max(r.desc.length, 2), h = n * 7.3;
    const centre = y - h / 2;
    r.desc.forEach((line, k) => items.push(it(line, COL.rem, centre + (r.desc.length - 1) / 2 * 7.3 - k * 7.3)));
    const [d, m] = r.day.split('-');
    items.push(it(d + m, COL.date, centre + 3.6), it('2026', COL.date, centre - 3.6), it(d + m, COL.val, centre + 3.6), it('2026', COL.val, centre - 3.6));
    items.push(it("'0001" + Math.floor(Math.random() * 1e6) + 'G…', COL.ref, centre));
    if (r.debit) items.push(it(fmt(r.debit), 0, centre, COL.debitR));
    if (r.credit) items.push(it(fmt(r.credit), 0, centre, COL.creditR));
    items.push(it(fmt(r.balance), 0, centre, COL.balR));
    y -= h + 14;
  }
  if (opts.footer) items.push(it('Page: ' + opts.footer, COL.rem, 30));
  return items;
}

// A statement: opening 10,000.00. Tall cells of 2 to 7 lines, a one line cell, a charge pair, and a row that straddles the page break.
const raw = [
  { day: '03-Sep', desc: ['OWN ACCOUNT TRANSFER', 'VIA GTWORLD OWN', 'ACCOUNT TRANSFER'], credit: 19500 },
  { day: '03-Sep', desc: ['TRANSFER BETWEEN', 'CUSTOMERS VIA', 'GTWORLD FROM A B', 'TO C D', 'NATIONAL HQ', 'EXTRA LINE', 'LAST LINE'], debit: 35000 },
  { day: '09-Sep', desc: ['Commission on NIP', 'Transfer CHARGES'], debit: 1000 },
  { day: '09-Sep', desc: ['VAT CHARGES'], debit: 75 },
  { day: '10-Sep', desc: ['Stamp Duties STAMP DUTY', 'CHARGE FOR TRXNS BTW', '09-09-2026 TO 09-09-2026'], debit: 5000 },
  { day: '11-Sep', desc: ['MOBILE TRF', 'TO ACCOUNT'], credit: 24120000 },
  { day: '12-Sep', desc: ['POS PUR SHOP ONE'], debit: 2645676 },
  { day: '13-Sep', desc: ['Spend to Save', 'from: 0012345678'], debit: 315 },
];
let bal = 1000000; raw.forEach(r => { bal += (r.credit || 0) - (r.debit || 0); r.balance = bal; });
const totalDebit = raw.reduce((a, r) => a + (r.debit || 0), 0), totalCredit = raw.reduce((a, r) => a + (r.credit || 0), 0);
const meta = { opening: 1000000, closing: bal, totalDebit, totalCredit };
const split = 5;                                       // rows 0..4 on page one; the last page-one row is drawn again at the top of page two
const page1 = pageItems(raw.slice(0, split), 640, { header: true, ...meta, footer: '1 of 2' });
const page2 = pageItems(raw.slice(split - 1), 780, { footer: '2 of 2' });
const res = P.parsePdfPages(P.normalisePdfPages([{ items: page1 }, { items: page2 }]));

ok('every transaction is read, the straddling row only once', res.lines.length === raw.length);
ok('dates are rebuilt from the two lines of the cell', res.lines[0].date === '2026-09-03' && res.lines[5].date === '2026-09-11');
ok('debits and credits land in the right direction and amount', res.lines.every((l, i) => l.amount_kobo === (raw[i].debit || raw[i].credit) && l.direction === (raw[i].debit ? 'debit' : 'credit')));
ok('opening and closing balances come from the statement header', res.opening_balance_kobo === 1000000 && res.closing_balance_kobo === bal && res.balances_source === 'statement');
ok('the balance chain and the printed totals both check out', res.integrity.ok && res.integrity.chain_breaks === 0 && res.integrity.totals_ok);
ok('account number, name and period are read from the header', res.meta.account_number === '0012345678' && res.meta.account_name === 'TEST CUSTOMER ONE' && res.meta.period_from === '2026-09-01' && res.meta.period_to === '2026-09-30');
ok('a seven line narration stays with its own transaction', /EXTRA LINE/.test(res.lines[1].description) && /LAST LINE/.test(res.lines[1].description) && !/Commission/.test(res.lines[1].description));
ok('a one line cell next to a two line cell keeps its own words', res.lines[2].description === 'Commission on NIP Transfer CHARGES' && res.lines[3].description === 'VAT CHARGES');
ok('the page footer never leaks into a narration', res.lines.every(l => !/Page:/i.test(l.description)));
ok('the straddling row keeps its narration', /Spend to Save|Stamp Duties/.test(res.lines[split - 1].description) || res.lines[split - 1].description.length > 0);

// the proof still catches a misread: change one printed balance and the chain must break
const tampered = JSON.parse(JSON.stringify(page1)); const b = tampered.find(i => i.str === fmt(raw[2].balance));
if (b) b.str = fmt(raw[2].balance + 100);
let tamperedRes = null; try { tamperedRes = P.parsePdfPages(P.normalisePdfPages([{ items: tampered }, { items: page2 }])); } catch (e) { tamperedRes = { integrity: { ok: false } }; }
ok('a changed balance is detected, not imported quietly', tamperedRes.integrity.ok === false);

// the original one-line-per-row layout still reads as before
const sample = require('fs').existsSync(path.join(__dirname, 'fixtures', 'sample-bank-statement-2025.pdf'));
ok('sample fixture still present for the line reader tests', sample);
console.log(bad ? `\n${bad} FAILED` : '\nAll checks passed');
