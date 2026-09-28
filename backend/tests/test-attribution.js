/**
 * zillion/backend/tests/test-attribution.js
 *
 * Opening-balance attribution guard rails: never posts to the ledger, never exceeds the unallocated amount,
 * idempotent for shares, all-or-nothing for savings, refuses invalid input.
 * Run: node backend/tests/test-attribution.js
 */
const path = require('path').join(__dirname, '..', 'lib') + '/';
const { getAttributionContext, applyAttribution } = require(path + 'coopAttribution');
const { computeSubledger, computeSubledgerDetail } = require(path + 'coopSubledgers');

function makeDb(tables) {
  const db = { tables, failUpdateFor: null, onUpdate: null, from(t) {
    const get = (row, col) => col.split('.').reduce((o, k) => (o == null ? o : o[k]), row);
    const f = []; let lo = null, hi = null, single = false, lim = null, insertRows = null, patch = null, selectAfterWrite = false, order = null;
    const q = {
      select() { if (patch) selectAfterWrite = true; return q; }, order(c, o) { order = [c, !(o && o.ascending === false)]; return q; }, limit(n) { lim = n; return q; },
      eq(c, v) { f.push(r => get(r, c) === v); return q; }, lte(c, v) { f.push(r => get(r, c) != null && String(get(r, c)) <= String(v)); return q; },
      in(c, a) { f.push(r => a.includes(get(r, c))); return q; }, not() { f.push(r => get(r, 'activated_at') !== null && get(r, 'activated_at') !== undefined); return q; },
      range(a, b) { lo = a; hi = b; return q; }, maybeSingle() { single = true; return q; },
      insert(rows) { insertRows = rows; return q; }, update(p) { patch = p; return q; },
      then(res) {
        tables[t] = tables[t] || [];
        if (insertRows) { for (const r of insertRows) tables[t].push({ id: 'gen' + tables[t].length, ...r }); return res({ data: insertRows, error: null }); }
        if (patch) {
          if (db.onUpdate) db.onUpdate(t, f);
          const hit = tables[t].filter(r => f.every(fn => fn(r)));
          const idFilter = hit[0] && hit[0].id;
          if (db.failUpdateFor && hit.some(r => r.id === db.failUpdateFor)) return res({ data: null, error: { message: 'simulated failure' } });
          hit.forEach(r => Object.assign(r, patch));
          return res({ data: selectAfterWrite ? hit.map(r => ({ id: r.id })) : null, error: null });
        }
        let rows = tables[t].filter(r => f.every(fn => fn(r)));
        if (order) rows = [...rows].sort((a, b) => String(a[order[0]]).localeCompare(String(b[order[0]])) * (order[1] ? 1 : -1));
        if (lim !== null) rows = rows.slice(0, lim); else if (lo !== null) rows = rows.slice(lo, hi + 1); else if (!single) rows = rows.slice(0, 1000);
        return res({ data: single ? (rows[0] || null) : rows, error: null });
      } }; return q; } };
  return db;
}
const C = 'C1';
function fresh(glOverride = {}) {
  const gl = { 3000: 50000000, 2000: 10000000, ...glOverride };
  const db = makeDb({
    coop_members: [ { id: 'A', coop_id: C, name: 'Ada', phone_normalized: '+1', activated_at: '2026-01-01T00:00:00Z', opening_balance_kobo: 2000000 },
                    { id: 'B', coop_id: C, name: 'Bola', phone_normalized: '+2', activated_at: '2026-01-01T00:00:00Z', opening_balance_kobo: 0 },
                    { id: 'C', coop_id: C, name: 'Chidi', phone_normalized: '+3', activated_at: '2026-01-01T00:00:00Z', opening_balance_kobo: 0 },
                    { id: 'P', coop_id: C, name: 'Pending', phone_normalized: '+4', activated_at: null, opening_balance_kobo: 0 } ],
    coop_share_transactions: [ { id: 's1', coop_id: C, member_id: 'A', amount_kobo: 10000000, source: 'cash_in_person', recorded_at: '2026-02-01T00:00:00Z', reference: null } ],
    coop_savings_transactions: [], coop_savings_plans: [ { id: 'P1', coop_id: C, member_id: 'A' } ],
    coop_dividend_runs: [], coop_dividend_entitlements: [], coop_dividend_payouts: [], coop_societies: [{ coop_id: C, dues_amount_kobo: 0 }],
    coop_journal_entries: [ { id: 'j1', coop_id: C, entry_type: 'manual', entry_date: '2026-03-01' }, { id: 'j2', coop_id: C, entry_type: 'opening_balance', entry_date: '2026-01-15' } ],
  });
  const deps = { computeAccountBalances: async () => Object.entries(gl).map(([code, balance]) => ({ id: 'acc' + code, account_code: code, account_name: 'N' + code, balance })) };
  return { db, deps };
}
let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };
const opts = { date: undefined, batchId: 'batch-0001', actor: 'portal:M1' };

(async () => {
  let { db, deps } = fresh();
  let ctx = await getAttributionContext(db, C, 'shares', deps);
  ok('ctx: unallocated = ledger 50,000,000 - members 10,000,000', ctx.ok && ctx.unallocated_kobo === 40000000);
  ok('ctx: lists activated members only (a pending member is excluded), including members with nothing yet', ctx.members.map(m => m.id).join() === 'A,B,C' && ctx.members.find(m => m.id === 'B').current_kobo === 0);
  ok('ctx: default date is the society\'s opening-balance entry date', ctx.default_date === '2026-01-15');
  ok('ctx: unsupported type refused', (await getAttributionContext(db, C, 'loans', deps)).ok === false);
  ctx = await getAttributionContext(db, C, 'savings', deps);
  ok('savings ctx: members without a savings plan are flagged (their opening balance would be invisible in the app)', ctx.members.find(m => m.id === 'B').no_plan === true && ctx.members.find(m => m.id === 'A').no_plan === false);

  // ---- shares: the exact remainder, split across members
  const journalBefore = db.tables.coop_journal_entries.length;
  let r = await applyAttribution(db, C, 'shares', [{ member_id: 'B', amount_kobo: 25000000 }, { member_id: 'C', amount_kobo: 15000000 }], opts, deps);
  ok('shares: attributing exactly the remainder succeeds and leaves nothing unallocated', r.ok && r.unallocated_before_kobo === 40000000 && r.unallocated_after_kobo === 0);
  const rows = db.tables.coop_share_transactions.filter(x => x.source === 'opening_balance');
  ok('shares: recorded as opening_balance transactions dated at the opening date, tagged with batch and actor', rows.length === 2 && rows.every(x => x.recorded_at === '2026-01-15T00:00:00Z' && x.reference === 'Opening balance attribution batch-0001' && x.recorded_by === 'portal:M1'));
  ok('shares: NOTHING was posted to the ledger (the ledger already holds this money)', db.tables.coop_journal_entries.length === journalBefore);
  const again = await applyAttribution(db, C, 'shares', [{ member_id: 'B', amount_kobo: 25000000 }], opts, deps);
  ok('shares: replaying the same batch is refused and writes nothing more', again.ok === false && again.status === 409 && db.tables.coop_share_transactions.filter(x => x.source === 'opening_balance').length === 2);
  const more = await applyAttribution(db, C, 'shares', [{ member_id: 'B', amount_kobo: 100 }], { ...opts, batchId: 'batch-0002' }, deps);
  ok('shares: once fully attributed, a further batch is refused', more.ok === false && more.status === 409 && /already fully attributed/.test(more.error));
  // the two reports must still agree after attribution
  const list = await computeSubledger(db, C, 'shares', null, deps);
  const detB = await computeSubledgerDetail(db, C, 'shares', 'B', null);
  ok('after: sub-ledger now reconciles and the drill-down total equals the list figure', list.reconciled === true && detB.totals.share_capital === list.rows.find(x => x.member_id === 'B').values.share_capital && detB.totals.share_capital === 25000000);

  // ---- shares: refusals write nothing
  ({ db, deps } = fresh());
  const n0 = db.tables.coop_share_transactions.length;
  r = await applyAttribution(db, C, 'shares', [{ member_id: 'B', amount_kobo: 41000000 }], opts, deps);
  ok('over-attribution is refused, states the excess, and writes nothing', r.ok === false && r.status === 400 && /Reduce the amounts by ₦10,000\.00/.test(r.error) && db.tables.coop_share_transactions.length === n0);
  const cases = [
    ['zero amount', [{ member_id: 'B', amount_kobo: 0 }]], ['negative amount', [{ member_id: 'B', amount_kobo: -5 }]], ['fractional kobo', [{ member_id: 'B', amount_kobo: 10.5 }]],
    ['duplicate member', [{ member_id: 'B', amount_kobo: 1 }, { member_id: 'B', amount_kobo: 1 }]], ['unknown member', [{ member_id: 'ZZZ', amount_kobo: 1 }]],
    ['member not yet activated', [{ member_id: 'P', amount_kobo: 1 }]], ['empty list', []], ['not an array', 'x'] ];
  for (const [name, a] of cases) { const x = await applyAttribution(db, C, 'shares', a, opts, deps); ok(`refused: ${name}`, x.ok === false && db.tables.coop_share_transactions.length === n0); }
  ok('refused: malformed batch id', (await applyAttribution(db, C, 'shares', [{ member_id: 'B', amount_kobo: 1 }], { ...opts, batchId: 'x' }, deps)).ok === false);
  ok('refused: unsupported type (loans)', (await applyAttribution(db, C, 'loans', [{ member_id: 'B', amount_kobo: 1 }], opts, deps)).ok === false);
  ok('refused: bad date', (await applyAttribution(db, C, 'shares', [{ member_id: 'B', amount_kobo: 1 }], { ...opts, date: '15/01/2026' }, deps)).ok === false);
  ok('refused: future date', (await applyAttribution(db, C, 'shares', [{ member_id: 'B', amount_kobo: 1 }], { ...opts, date: '2999-01-01' }, deps)).ok === false);
  ok('a partial attribution is fine and leaves the rest unallocated', (await applyAttribution(db, C, 'shares', [{ member_id: 'B', amount_kobo: 10000000 }], opts, deps)).unallocated_after_kobo === 30000000);

  // ---- savings: member-level opening balance
  ({ db, deps } = fresh());
  r = await applyAttribution(db, C, 'savings', [{ member_id: 'B', amount_kobo: 3000000 }, { member_id: 'C', amount_kobo: 5000000 }], opts, deps);
  ok('savings: opening balances raised on the member records; unallocated cleared', r.ok && r.unallocated_before_kobo === 8000000 && r.unallocated_after_kobo === 0 && db.tables.coop_members.find(m => m.id === 'B').opening_balance_kobo === 3000000);
  ({ db, deps } = fresh({ 2000: 1000000 }));
  r = await applyAttribution(db, C, 'savings', [{ member_id: 'B', amount_kobo: 100 }], opts, deps);
  ok('savings: when members ALREADY exceed the ledger nothing can be attributed, and the message says why', r.ok === false && r.status === 409 && /already exceed the ledger/.test(r.error));
  ({ db, deps } = fresh());
  db.failUpdateFor = 'C';
  r = await applyAttribution(db, C, 'savings', [{ member_id: 'B', amount_kobo: 3000000 }, { member_id: 'C', amount_kobo: 5000000 }], opts, deps);
  ok('savings: a failure part-way rolls the earlier members back - all or nothing', r.ok === false && r.status === 500 && db.tables.coop_members.find(m => m.id === 'B').opening_balance_kobo === 0 && db.tables.coop_members.find(m => m.id === 'C').opening_balance_kobo === 0);
  ({ db, deps } = fresh());
  let fired = false; db.onUpdate = () => { if (!fired) { fired = true; db.tables.coop_members.find(m => m.id === 'B').opening_balance_kobo = 999; } };
  r = await applyAttribution(db, C, 'savings', [{ member_id: 'B', amount_kobo: 3000000 }], opts, deps);
  ok('savings: a record changed by someone else mid-flight is a conflict, not silently overwritten', r.ok === false && r.status === 409 && db.tables.coop_members.find(m => m.id === 'B').opening_balance_kobo === 999);
  console.log(bad ? `\n${bad} FAILED` : '\nALL PASSED');
})().catch(e => { console.log('ERROR', e.stack); process.exitCode = 1; });
