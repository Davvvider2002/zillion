/**
 * Tests go-live catch-up foundations: lib/coopGoLiveBatch.js (the date and batch gate), the optional entry date and
 * batch tag threaded through lib/coopAccountingHelpers.js, and back-dated join and exit in coopActivateMember.js.
 * Uses a small in-memory fake of the Supabase query builder. Run: node backend/tests/test-go-live-foundations.js
 */
'use strict';
const path = require('path');
const LIB = path.join(__dirname, '..', 'lib');
const { parseDay, isRealDay, resolveGoLiveInput } = require(path.join(LIB, 'coopGoLiveBatch'));
const helpers = require(path.join(LIB, 'coopAccountingHelpers'));

let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };

function fakeDb(seed) {
  const t = JSON.parse(JSON.stringify(seed));
  let n = 0;
  const from = name => {
    t[name] = t[name] || [];
    const st = { f: [], ord: null, lim: null, op: 'select', row: null };
    const run = () => {
      let rows = t[name].filter(r => st.f.every(([k, v]) => r[k] === v));
      if (st.ord) rows = rows.slice().sort((a, b) => (a[st.ord.k] < b[st.ord.k] ? 1 : -1) * (st.ord.asc ? -1 : 1));
      if (st.lim != null) rows = rows.slice(0, st.lim);
      return rows;
    };
    const q = {
      select() { return q; }, eq(k, v) { st.f.push([k, v]); return q; },
      order(k, o) { st.ord = { k, asc: o && o.ascending !== false }; return q; }, limit(x) { st.lim = x; return q; },
      insert(r) { st.op = 'insert'; st.row = r; return q; },
      delete() { st.op = 'delete'; return q; },
      maybeSingle: async () => ({ data: run()[0] || null }),
      single: async () => {
        if (st.op === 'insert') { const r = { id: 'id' + (++n), ...st.row }; t[name].push(r); return { data: r, error: null }; }
        return { data: run()[0] || null };
      },
      then(res) {
        if (st.op === 'insert') { const rows = [].concat(st.row).map(r => ({ id: 'id' + (++n), ...r })); t[name].push(...rows); return Promise.resolve({ data: rows, error: null }).then(res); }
        if (st.op === 'delete') { const dead = new Set(run()); t[name] = t[name].filter(r => !dead.has(r)); return Promise.resolve({ error: null }).then(res); }
        return Promise.resolve({ data: run(), error: null }).then(res);
      },
    };
    return q;
  };
  return { from, tables: t };
}

(async () => {
  // ── date parsing
  ok('isRealDay accepts a real day', isRealDay('2026-02-28'));
  ok('isRealDay rejects 30 February', !isRealDay('2026-02-30'));
  ok('isRealDay rejects a loose format', !isRealDay('2026-2-3') && !isRealDay('03/02/2026') && !isRealDay(''));
  const p = parseDay('2026-03-05');
  ok('parseDay stamps noon Lagos time, the same calendar day in UTC', p.ok && p.recordedAt === '2026-03-05T12:00:00+01:00' && new Date(p.recordedAt).toISOString().slice(0, 10) === '2026-03-05');
  ok('parseDay names the field in its error', parseDay('nope', 'joined_on').error.startsWith('joined_on'));

  // ── the gate
  const db = fakeDb({ coop_migration_batches: [
    { id: 'B1', coop_id: 'C1', status: 'draft',  fy_start: '2026-01-01', cutover_date: '2026-09-30' },
    { id: 'B2', coop_id: 'C2', status: 'draft',  fy_start: '2026-01-01', cutover_date: '2026-09-30' },
    { id: 'B3', coop_id: 'C1', status: 'locked', fy_start: '2025-01-01', cutover_date: '2025-06-30' },
  ] });
  let r = await resolveGoLiveInput(db, 'C1', { amount_kobo: 100 });
  ok('no go-live fields: live path, nothing back-dated', r.ok && r.active === false);
  r = await resolveGoLiveInput(db, 'C1', { as_of_date: '2026-03-05' });
  ok('a date without a batch is refused, so a stray date cannot back-date a live record', !r.ok && r.status === 400);
  r = await resolveGoLiveInput(db, 'C1', { migration_batch_id: 'B1' });
  ok('a batch without a date is refused', !r.ok && r.status === 400);
  r = await resolveGoLiveInput(db, 'C1', { migration_batch_id: 'B1', as_of_date: '2026-03-05' });
  ok('valid draft batch and in-window date is accepted', r.ok && r.active && r.recordedAt === '2026-03-05T12:00:00+01:00' && r.opts.entryDate === '2026-03-05' && r.opts.batchId === 'B1');
  r = await resolveGoLiveInput(db, 'C1', { migration_batch_id: 'B2', as_of_date: '2026-03-05' });
  ok('another society\'s batch is refused with 403', !r.ok && r.status === 403);
  r = await resolveGoLiveInput(db, 'C1', { migration_batch_id: 'B3', as_of_date: '2025-03-05' });
  ok('a locked batch accepts nothing (409)', !r.ok && r.status === 409);
  r = await resolveGoLiveInput(db, 'C1', { migration_batch_id: 'NOPE', as_of_date: '2026-03-05' });
  ok('unknown batch is 404', !r.ok && r.status === 404);
  r = await resolveGoLiveInput(db, 'C1', { migration_batch_id: 'B1', as_of_date: '2025-12-31' });
  ok('date before the financial year start is refused', !r.ok && r.status === 400);
  r = await resolveGoLiveInput(db, 'C1', { migration_batch_id: 'B1', as_of_date: '2026-10-01' });
  ok('date after the cutover is refused', !r.ok && r.status === 400);
  r = await resolveGoLiveInput(db, 'C1', { migration_batch_id: 'B1', as_of_date: '2026-02-30' });
  ok('an impossible date is refused', !r.ok && r.status === 400);

  // ── journal posting helpers
  const jdb = fakeDb({});
  const dr = { id: 'A1', currency: 'NGN' }, cr = { id: 'A2', currency: 'NGN' };
  await helpers.postEntry(jdb, 'C1', 'live', 'x', dr, cr, 500);
  const today = new Date().toISOString().slice(0, 10);
  const live = jdb.tables.coop_journal_entries[0];
  ok('live posting is unchanged: dated today, no batch tag', live.entry_date === today && !('migration_batch_id' in live));
  await helpers.postEntry(jdb, 'C1', 'caught up', 'x', dr, cr, 700, { entryDate: '2026-03-05', batchId: 'B1' });
  const old = jdb.tables.coop_journal_entries[1];
  ok('catch-up posting carries the real date and the batch', old.entry_date === '2026-03-05' && old.migration_batch_id === 'B1');
  await helpers.postEntryLines(jdb, 'C1', 'lines', 'x', [{ account: dr, type: 'debit', amountKobo: 5 }, { account: cr, type: 'credit', amountKobo: 5 }], { entryDate: '2026-04-01', batchId: 'B1' });
  ok('multi-line posting honours the same options', jdb.tables.coop_journal_entries[2].entry_date === '2026-04-01');
  ok('entry numbers still run in order', jdb.tables.coop_journal_entries.map(e => e.entry_number).join() === '1,2,3');

  // ── member activation with a past join date and an exit
  const adb = fakeDb({ coop_members: [] });
  const { activateMember } = require(path.join(LIB, 'coopActivateMember'));
  delete process.env.SUPABASE_SERVICE_KEY;
  let m = await activateMember(adb, { coopId: 'C1', rawPhone: '08031234567', name: 'Ada', openingBalanceKobo: 0, activatedBy: 'u', joinedOn: '2019-05-10', migrationBatchId: 'B1' });
  ok('past join date becomes the activation date', m.ok && m.member.activated_at === '2019-05-10T12:00:00+01:00' && m.member.migration_batch_id === 'B1');
  m = await activateMember(adb, { coopId: 'C1', rawPhone: '08031234568', name: 'Bayo', openingBalanceKobo: 0, activatedBy: 'u', joinedOn: '2024-01-15', exitedOn: '2026-04-30', exitReason: 'Relocated' });
  ok('an exit date marks the member EXITED with a reason', m.ok && m.member.status === 'EXITED' && m.member.exited_at === '2026-04-30T12:00:00+01:00' && m.member.exit_reason === 'Relocated');
  m = await activateMember(adb, { coopId: 'C1', rawPhone: '08031234569', name: 'Chi', openingBalanceKobo: 0, activatedBy: 'u', joinedOn: '2024-01-15', exitedOn: '2023-01-01' });
  ok('exit before join is refused', !m.ok && /before/.test(m.error));
  m = await activateMember(adb, { coopId: 'C1', rawPhone: '08031234560', name: 'Dayo', openingBalanceKobo: 0, activatedBy: 'u', joinedOn: '2999-01-01' });
  ok('a future join date is refused', !m.ok && /future/.test(m.error));
  m = await activateMember(adb, { coopId: 'C1', rawPhone: '08031234561', name: 'Eke', openingBalanceKobo: 0, activatedBy: 'u' });
  ok('a plain activation is unchanged: no activated_at override, no status override', m.ok && !('activated_at' in m.member) && !('status' in m.member));

  console.log(bad ? `\n${bad} FAILED` : '\nAll go-live foundation tests passed');
})();
