/** Go-live phase 5: time-weighted shares, exited members, inclusive year end, savings basis, imported / live split. Run: node backend/tests/test-dividend-phase5.js */
'use strict';
const path = require('path');
const { calculateDividendRun, timeWeightedShares } = require(path.join(__dirname, '..', 'lib', 'coopDividendCalculation'));
let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };

function makeDb(tables) {
  const get = (r, c) => c.split('.').reduce((o, k) => (o == null ? o : o[k]), r);
  return { from(t) {
    const f = []; const q = {
      select() { return q; }, order() { return q; }, limit() { return q; }, range() { return q; },
      eq(c, v) { f.push(r => get(r, c) === v); return q; },
      gte(c, v) { f.push(r => String(get(r, c)) >= String(v)); return q; }, lte(c, v) { f.push(r => String(get(r, c)) <= String(v)); return q; },
      then(res) { res({ data: (tables[t] || []).filter(r => f.every(fn => fn(r))), error: null }); } };
    return q;
  } };
}

(async () => {
  const S = '2026-01-01', E = '2026-12-31';
  ok('shares held all year count in full', timeWeightedShares([{ amount_kobo: 100000, recorded_at: '2025-12-31T12:00:00+01:00' }], S, E) === 100000);
  ok('a July top up counts for the 184 days left', timeWeightedShares([{ amount_kobo: 100000, recorded_at: '2025-12-31' }, { amount_kobo: 20000, recorded_at: '2026-07-01T12:00:00+01:00' }], S, E) === 110082);
  ok('a member who joined 1 October earns on 92 days', timeWeightedShares([{ amount_kobo: 120000, recorded_at: '2026-10-01T12:00:00+01:00' }], S, E) === 30247);
  ok('a member who left on 30 April earns on 120 days', timeWeightedShares([{ amount_kobo: 60000, recorded_at: '2025-06-01' }], S, E, '2026-04-30') === 19726);
  ok('a member who left before the year earns nothing', timeWeightedShares([{ amount_kobo: 60000, recorded_at: '2025-06-01' }], S, E, '2025-11-01') === 0);

  const C = 'C1';
  const tables = {
    coop_members: [
      { id: 'A', coop_id: C, status: 'ACTIVE' }, { id: 'B', coop_id: C, status: 'ACTIVE' },
      { id: 'X', coop_id: C, status: 'EXITED', exited_at: '2026-04-30T12:00:00+01:00' }, { id: 'Y', coop_id: C, status: 'EXITED', exited_at: '2025-11-01T12:00:00+01:00' },
    ],
    coop_savings_transactions: [
      { id: 1, coop_id: C, member_id: 'A', amount_kobo: 50000, recorded_at: '2026-03-10T12:00:00+01:00', migration_batch_id: 'B1' },
      { id: 2, coop_id: C, member_id: 'A', amount_kobo: -10000, recorded_at: '2026-05-10T12:00:00+01:00', migration_batch_id: null },
      { id: 3, coop_id: C, member_id: 'A', amount_kobo: 7000, recorded_at: '2026-12-31T12:00:00+01:00', migration_batch_id: null },
      { id: 4, coop_id: C, member_id: 'X', amount_kobo: 30000, recorded_at: '2026-02-01T12:00:00+01:00', migration_batch_id: 'B1' },
      { id: 5, coop_id: C, member_id: 'Y', amount_kobo: 99999, recorded_at: '2026-02-01T12:00:00+01:00', migration_batch_id: 'B1' },
    ],
    coop_dues_transactions: [], coop_loans: [], coop_loan_repayments: [],
    coop_share_transactions: [
      { id: 1, coop_id: C, member_id: 'A', amount_kobo: 100000, recorded_at: '2025-12-31T12:00:00+01:00', migration_batch_id: 'B1' },
      { id: 2, coop_id: C, member_id: 'A', amount_kobo: 20000, recorded_at: '2026-07-01T12:00:00+01:00', migration_batch_id: null },
      { id: 3, coop_id: C, member_id: 'B', amount_kobo: 120000, recorded_at: '2026-10-01T12:00:00+01:00', migration_batch_id: null },
      { id: 4, coop_id: C, member_id: 'X', amount_kobo: 60000, recorded_at: '2025-12-31T12:00:00+01:00', migration_batch_id: 'B1' },
    ],
  };
  const db = makeDb(tables), POOL = 1000000;
  const by = r => Object.fromEntries(r.entitlements.map(e => [e.member_id, e]));

  let r = await calculateDividendRun(db, C, S, E, POOL, 50);
  ok('legacy defaults still skip exited members and use the year end balance', !by(r).X && !by(r).Y && by(r).A.share_capital_kobo === 120000);
  ok('the year end day is included', by(r).A.patronage_savings_kobo === 47000);

  r = await calculateDividendRun(db, C, S, E, POOL, 50, { shareBasis: 'time_weighted', includeExited: true });
  const e = by(r);
  ok('exited members who served part of the year are included, others are not', !!e.X && !e.Y && e.X.member_status === 'EXITED');
  ok('time weighted shares are used as the share basis', e.A.share_capital_kobo === 110082 && e.B.share_capital_kobo === 30247 && e.X.share_capital_kobo === 19726);
  ok('the year end balance is kept alongside', e.A.year_end_share_capital_kobo === 120000);
  ok('the pool is shared out in full', Math.abs(r.entitlements.reduce((s, x) => s + x.entitlement_kobo, 0) - POOL) <= r.entitlements.length);
  ok('imported and live patronage are split', e.A.imported_patronage_kobo === 50000 && e.A.live_patronage_kobo === -3000 && e.A.imported_share_capital_kobo === 100000 && e.A.live_share_capital_kobo === 20000);

  r = await calculateDividendRun(db, C, S, E, POOL, 0, { savingsBasis: 'deposits', includeExited: true });
  ok('deposits only ignores withdrawals', by(r).A.patronage_savings_kobo === 57000);
  console.log(bad ? `\n${bad} FAILED` : '\nAll phase 5 tests passed');
})();
