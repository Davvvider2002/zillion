/**
 * zillion/backend/tests/test-loan-completion.js
 *
 * Total-remaining balance (whole schedule + penalties - paid, NOT just what is due so far) and closing a loan
 * as COMPLETED once nothing remains. Run: node backend/tests/test-loan-completion.js
 */
const { computeTotalRemainingKobo, finalizeLoanIfFullyRepaid } = require('../lib/coopLoanCompletion');

// Stub DB: chainable, thenable, records updates. Serves the 3 tables the real status lib reads.
function makeDb({ schedule = [], repayments = [], penalties = [] }) {
  const updates = [];
  const tables = { coop_loan_repayment_schedule: schedule, coop_loan_repayments: repayments, coop_loan_penalties: penalties };
  return {
    updates,
    from(table) {
      const q = { _table: table, _update: null, _filters: [] };
      q.select = () => q;
      q.eq = (col, val) => { q._filters.push(['eq', col, val]); return q; };
      q.in = (col, vals) => { q._filters.push(['in', col, vals]); return q; };
      q.order = () => q;
      q.update = (patch) => { q._update = patch; return q; };
      q.then = (resolve) => {
        if (q._update) { updates.push({ table, patch: q._update, filters: q._filters }); return resolve({ data: null, error: null }); }
        return resolve({ data: tables[table] || [], error: null });
      };
      return q;
    },
  };
}
const past = '2020-01-01', future = '2999-01-01';
const loan = { id: 'L1', principal_kobo: 8000000, total_repayable_kobo: 10000000 }; // ₦100,000 total
const society = {};
const ok = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); if (!cond) process.exitCode = 1; };

(async () => {
  // A: 4 x ₦25,000, only the first is due yet, nothing paid.
  const sched = [ {period_number:1,due_date:past,amount_due_kobo:2500000}, {period_number:2,due_date:future,amount_due_kobo:2500000},
                  {period_number:3,due_date:future,amount_due_kobo:2500000}, {period_number:4,due_date:future,amount_due_kobo:2500000} ];
  let rem = await computeTotalRemainingKobo(makeDb({ schedule: sched }), loan, society);
  ok('A: total remaining is the WHOLE ₦100,000, not just the ₦25,000 due so far (so an early/extra ₦40,000 is allowed)', rem === 10000000);

  // B: ₦60,000 already paid -> ₦40,000 left; a ₦70,000 attempt must exceed it
  rem = await computeTotalRemainingKobo(makeDb({ schedule: sched, repayments: [{amount_kobo: 6000000}] }), loan, society);
  ok('B: after ₦60,000 paid, remaining is ₦40,000', rem === 4000000);
  ok('B: a ₦70,000 payment would exceed remaining (endpoint refuses it)', 7000000 > rem);
  ok('B: paying exactly the remaining ₦40,000 is allowed', 4000000 <= rem);

  // C: stored penalties are part of what is owed
  rem = await computeTotalRemainingKobo(makeDb({ schedule: sched, repayments: [{amount_kobo: 10000000}], penalties: [{amount_kobo: 500000}] }), loan, society);
  ok('C: fully paid the schedule but a ₦5,000 penalty is still owed -> remaining ₦5,000', rem === 500000);

  // D: completion fires when nothing remains, and only from DISBURSED/REPAYING
  let db = makeDb({ schedule: sched, repayments: [{amount_kobo: 10000000}] });
  let r = await finalizeLoanIfFullyRepaid(db, loan, society);
  ok('D: fully repaid -> completed=true', r.completed === true && r.remainingKobo === 0);
  const upd = db.updates.find(u => u.table === 'coop_loans');
  ok('D: wrote status COMPLETED to coop_loans', upd && upd.patch.status === 'COMPLETED');
  const guard = upd && upd.filters.find(f => f[0] === 'in' && f[1] === 'status');
  ok('D: UPDATE is guarded to DISBURSED/REPAYING only (cannot flip a REJECTED/DEFAULTED loan)', guard && guard[2].join() === 'DISBURSED,REPAYING');

  // E: not fully repaid -> no write at all
  db = makeDb({ schedule: sched, repayments: [{amount_kobo: 6000000}] });
  r = await finalizeLoanIfFullyRepaid(db, loan, society);
  ok('E: partly repaid -> completed=false and NO update issued', r.completed === false && db.updates.length === 0);

  // F: loan with no schedule (the historical bug case) falls back to total_repayable
  rem = await computeTotalRemainingKobo(makeDb({}), loan, society);
  ok('F: empty schedule falls back to the full total_repayable, not zero', rem === 10000000);
})();
