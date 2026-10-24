/** Go-live sheets sent in parts: the splitter, line numbers, and checks across parts. Run: node backend/tests/test-go-live-chunks.js */
'use strict';
const fs = require('fs'), path = require('path');
const LIB = path.join(__dirname, '..', 'lib');
delete process.env.SUPABASE_SERVICE_KEY;
const imp = require(path.join(LIB, 'coopGoLiveImport'));
const { fakeDb } = require('./helpers/goLiveFakeDb');
let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'coop-admin', 'index.html'), 'utf8');
const i = html.indexOf('function glSplitCsv'); let d = 0, k = html.indexOf('{', i);
for (; k < html.length; k++) { if (html[k] === '{') d++; if (html[k] === '}' && !--d) break; }
const glSplitCsv = new Function(html.slice(i, k + 1) + '; return glSplitCsv;')();

const rowsOf = n => Array.from({ length: n }, (_, j) => `r${j + 1},x`);
const text = ['a,b', ...rowsOf(7)].join('\n');
let sp = glSplitCsv(text, 3);
ok('7 rows with a limit of 3 make 3 parts of 3, 3 and 1', sp.parts.map(p => p.rows).join() === '3,3,1' && sp.rows === 7);
ok('every part repeats the header', sp.parts.every(p => p.text.startsWith('a,b\n')));
ok('the rows are all there, in order', sp.parts.map(p => p.text.split('\n').slice(1).join('\n')).join('\n') === rowsOf(7).join('\n'));
ok('line offsets point at the original lines', sp.parts.map(p => p.lineOffset).join() === '0,3,6');
ok('prior text holds every earlier line', sp.parts[2].priorText === ['a,b', ...rowsOf(6)].join('\n') && sp.parts[0].priorText === 'a,b');
sp = glSplitCsv('\n\na,b\n' + rowsOf(2).join('\n') + '\n\n\n', 5);
ok('blank lines around the data do not make parts', sp.parts.length === 1 && sp.rows === 2);
sp = glSplitCsv(['a,b', 'r1,x', '', 'r2,x', 'r3,x'].join('\n'), 2);
ok('a blank line inside is kept, not counted', sp.rows === 3 && sp.parts.map(p => p.rows).join() === '2,1' && sp.parts[1].lineOffset === 3);

// A savings sheet where part 2 withdraws money paid in by part 1.
const seed = {
  coop_societies: [{ coop_id: 'C1', name: 'T', base_currency: 'NGN' }],
  coop_migration_batches: [{ id: 'B1', coop_id: 'C1', status: 'draft', fy_start: '2026-01-01', cutover_date: '2026-09-30' }],
  coop_members: [{ id: 'm1', coop_id: 'C1', member_number: '0001', name: 'Ada', phone_normalized: '2348031234567', status: 'ACTIVE', opening_balance_kobo: 0 }],
};
(async () => {
  const batch = seed.coop_migration_batches[0];
  const db = fakeDb(seed);
  const head = 'member_no,date,type,amount';
  const part1 = `${head}\n0001,2026-02-01,deposit,1000\n0001,2026-03-01,deposit,500`;
  const part2 = `${head}\n0001,2026-04-01,withdrawal,1200`;
  const alone = await imp.runImport(db, { coopId: 'C1', batch, dataset: 'savings', text: part2, dryRun: true, actor: 't' });
  ok('on its own, the second part fails the balance check', alone.rejected === 1);
  const withPrior = await imp.runImport(db, { coopId: 'C1', batch, dataset: 'savings', text: part2, dryRun: true, actor: 't', priorText: part1, lineOffset: 3 });
  ok('checked with the earlier part, it passes', withPrior.ok && withPrior.rejected === 0 && withPrior.accepted === 1 && withPrior.rows_read === 1);
  const over = await imp.runImport(db, { coopId: 'C1', batch, dataset: 'savings', text: `${head}\n0001,2026-04-01,withdrawal,1600`, dryRun: true, actor: 't', priorText: part1, lineOffset: 3 });
  ok('and a withdrawal beyond both parts still fails, at the right line', over.rejected === 1 && over.errors[0].line === 5);
  ok('problems in the earlier part are not reported again', !(over.errors || []).some(e => e.line < 5));

  const a = await imp.runImport(db, { coopId: 'C1', batch, dataset: 'savings', text: part1, dryRun: false, actor: 't' });
  const b = await imp.runImport(db, { coopId: 'C1', batch, dataset: 'savings', text: part2, dryRun: false, actor: 't', lineOffset: 3 });
  ok('real loads of the two parts in turn both succeed', a.ok && b.ok && db.t().coop_savings_transactions.length === 3);
  const tooBig = await imp.runImport(db, { coopId: 'C1', batch, dataset: 'savings', text: head + '\n' + Array.from({ length: 501 }, () => '0001,2026-05-01,deposit,1').join('\n'), dryRun: true, actor: 't' });
  ok('a single request over the limit is still refused', !tooBig.ok && /too many/.test(tooBig.error));
  console.log(bad ? `\n${bad} FAILED` : '\nAll chunking tests passed');
})();
