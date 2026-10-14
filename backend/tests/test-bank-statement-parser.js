/**
 * zillion/backend/tests/test-bank-statement-parser.js
 * The statement reader, on the REAL sample PDF a bank produced and on Excel-shaped rows, plus the cases that must NOT import quietly:
 * a broken running balance, a wrong bank total, a scanned PDF, a non-PDF.
 * Run: node backend/tests/test-bank-statement-parser.js
 */
'use strict';
const fs = require('fs'); const path = require('path');
const P = require('../lib/bankStatementParser');
let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };
const throws = async (f) => { try { await f(); return null; } catch (e) { return e; } };

(async () => {
  // money and dates
  ok('money: 1,234.50 -> 123450', P.parseMoneyToKobo('1,234.50') === 123450);
  ok('money: (1,234.50) negative', P.parseMoneyToKobo('(1,234.50)') === -123450);
  ok('money: 500.00 DR negative', P.parseMoneyToKobo('500.00 DR') === -50000);
  ok('money: ₦2,000 -> 200000', P.parseMoneyToKobo('₦2,000') === 200000);
  ok('money: 0.07 has no float error', P.parseMoneyToKobo('0.07') === 7 && P.parseMoneyToKobo('1.1') === 110);
  ok('money: a reference number is not money', P.parseMoneyToKobo('000123456789') === null || P.parseMoneyToKobo('1,23,456') === null);
  ok('date: 03/01/2025 is 3 January (day first)', P.parseDate('03/01/2025') === '2025-01-03');
  ok('date: 5-Mar-2025', P.parseDate('5-Mar-2025') === '2025-03-05');
  ok('date: 31 Feb rejected', P.parseDate('31/02/2025') === null);
  ok('date: Excel serial 45658 = 2025-01-01', P.parseDate(45658) === '2025-01-01');

  // the real PDF
  const pdf = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-bank-statement-2025.pdf'));
  const r = await P.parsePdfBuffer(pdf);
  ok('pdf: 759 transactions', r.lines.length === 759);
  ok('pdf: opening balance 1,790,000.00 read from the statement', r.opening_balance_kobo === 179000000);
  ok('pdf: closing balance 9,985,874.34 read from the statement', r.closing_balance_kobo === 998587434);
  ok('pdf: total debits 238,915,000.00', r.total_debits_kobo === 23891500000);
  ok('pdf: total credits 247,110,874.34', r.total_credits_kobo === 24711087434);
  ok('pdf: opening + credits - debits = closing', r.opening_balance_kobo + r.total_credits_kobo - r.total_debits_kobo === r.closing_balance_kobo);
  ok('pdf: every running balance checks out', r.integrity.ok && r.integrity.chain_breaks === 0 && r.integrity.totals_ok === true);
  ok('pdf: account details read', r.meta.account_number === '0012344471' && r.meta.account_name === 'ADUNNI FOODS LIMITED' && r.meta.currency === 'NGN');
  ok('pdf: period read', r.meta.period_from === '2025-01-01' && r.meta.period_to === '2025-12-31');
  ok('pdf: balances_source is statement', r.balances_source === 'statement');
  ok('pdf: wrapped narrations rejoined (no line has a bare amount in its description)', r.lines.every(l => !/\b\d{1,3}(,\d{3})+\.\d{2}\b/.test(l.description)));
  ok('pdf: not a PDF is refused', (await throws(() => P.parsePdfBuffer(Buffer.from('hello world')))) instanceof P.StatementParseError);
  ok('pdf: corrupt PDF is refused with a clear error', (await throws(() => P.parsePdfBuffer(Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('garbage')])))) instanceof P.StatementParseError);
  ok('pdf: no text (scan) is refused', (await throws(() => P.parsePdfPages([{ items: [] }]))) instanceof P.StatementParseError);

  // Excel / CSV rows
  const hdr = ['Date', 'Narration', 'Debit', 'Credit', 'Balance'];
  const good = [['Account Name: TEST COOP'], ['Account Number: 0123456789'], hdr,
    ['01/03/2025', 'Opening Balance', '', '', '1,000.00'],
    ['02/03/2025', 'Deposit', '', '500.00', '1,500.00'],
    ['03/03/2025', 'Withdrawal', '200.00', '', '1,300.00'],
    ['Total Debits', '', '200.00', '', ''], ['Total Credits', '', '', '500.00', '']];
  const x = P.parseTableRows(good);
  ok('rows: opening and closing from the file', x.opening_balance_kobo === 100000 && x.closing_balance_kobo === 130000);
  ok('rows: directions from the columns', x.lines[0].direction === 'credit' && x.lines[1].direction === 'debit');
  ok('rows: file proves itself', x.integrity.ok);
  ok('rows: account number read', x.meta.account_number === '0123456789');
  const broken = JSON.parse(JSON.stringify(good)); broken[5][4] = '1,350.00';
  const bx = P.parseTableRows(broken);
  ok('rows: a wrong running balance is caught and located', !bx.integrity.ok && bx.integrity.chain_breaks >= 1 && bx.integrity.problems[0].date === '2025-03-03');
  const badTotal = JSON.parse(JSON.stringify(good)); badTotal[6][2] = '250.00';
  ok('rows: a wrong bank total is caught', !P.parseTableRows(badTotal).integrity.ok);
  const newest = [hdr, ['03/03/2025', 'Withdrawal', '200.00', '', '1,300.00'], ['02/03/2025', 'Deposit', '', '500.00', '1,500.00'], ['01/03/2025', 'Opening Balance', '', '', '1,000.00']];
  const nx = P.parseTableRows(newest);
  ok('rows: newest-first is turned round and still verifies', nx.integrity.ok && nx.closing_balance_kobo === 130000 && nx.warnings.length === 1);
  const signed = [['Date', 'Description', 'Amount', 'Balance'], ['01/03/2025', 'Opening Balance', '', '1000'], ['02/03/2025', 'In', '500', '1500'], ['03/03/2025', 'Out', '-200', '1300']];
  const sx = P.parseTableRows(signed);
  ok('rows: signed amounts give the direction', sx.lines[1].direction === 'debit' && sx.integrity.ok);
  const noBal = [['Date', 'Description', 'Debit', 'Credit'], ['01/03/2025', 'a', '', '100'], ['02/03/2025', 'b', '40', '']];
  const nb = P.parseTableRows(noBal);
  ok('rows: no balance column -> cannot invent balances, says so', nb.balances_source === 'missing' && nb.warnings.some(w => /no running balance/i.test(w)));
  ok('rows: no headings is refused', (await throws(() => P.parseTableRows([['x', 'y'], ['1', '2']]))) instanceof P.StatementParseError);
  const bothR = P.parseTableRows([hdr, ['01/03/2025', 'Opening Balance', '', '', '1000'], ['02/03/2025', 'x', '5', '5', '1000'], ['03/03/2025', 'y', '', '10', '1010']]);
  ok('rows: both-sides row appears in the problems list', !bothR.integrity.ok && bothR.integrity.problems.some(p => /both a debit and a credit/.test(p.issue)));
  console.log(bad ? `\n${bad} FAILED` : '\nAll statement parser checks passed');
})();
