/**
 * zillion/backend/tests/helpers/fakeDb.js
 *
 * In-memory stand-in for the Supabase client, faithful to the parts of PostgREST that have
 * actually mattered in this codebase:
 *   - an unpaged read is silently capped at 1,000 rows
 *   - .maybeSingle() ERRORS when more than one row matches (PGRST116), unless .limit() was used
 *   - unique constraints reject duplicates with code 23505 (UNIQUE (coop_id, entry_number) on
 *     journal entries; unique reference on the savings/dues/share/repayment ledgers)
 *   - db.raceOnce simulates a concurrent writer taking the next journal entry number
 *   - makeDb(tables, { defaults: { table: () => ({ col: value }) } }) fills column defaults on insert, as the real database's now() does
 *   - makeDb(tables, { project: true }) returns only the selected columns for plain column lists, as the real API does
 */
'use strict';

const DEFAULT_UNIQUE = {
  coop_journal_entries: ['coop_id', 'entry_number'],
  coop_savings_transactions: ['reference'], coop_dues_transactions: ['reference'],
  coop_share_transactions: ['reference'], coop_loan_repayments: ['reference'],
};

function makeDb(tables, opts = {}) {
  const unique = { ...DEFAULT_UNIQUE, ...(opts.unique || {}) };
  const get = (r, c) => c.split('.').reduce((o, k) => (o == null ? o : o[k]), r);
  const db = { tables, raceOnce: false, failNextInsertOn: null, queryCount: 0, from(t) {
    db.queryCount++;
    const f = []; let lo = null, hi = null, single = false, ins = null, patch = null, del = false, selAfter = false, ord = [], lim = null, selCols = null, ups = null;
    const q = {
      select(cols) { if (patch) selAfter = true; if (typeof cols === 'string') selCols = cols; return q; },
      order(c, o) { ord.push([c, !(o && o.ascending === false)]); return q; }, limit(n) { lim = n; return q; },
      eq(c, v) { f.push(r => get(r, c) === v); return q; }, neq(c, v) { f.push(r => get(r, c) !== v); return q; },
      gte(c, v) { f.push(r => get(r, c) != null && String(get(r, c)) >= String(v)); return q; },
      lte(c, v) { f.push(r => get(r, c) != null && String(get(r, c)) <= String(v)); return q; },
      in(c, a) { f.push(r => a.includes(get(r, c))); return q; },
      gt(c, v) { f.push(r => get(r, c) != null && (typeof v === 'number' ? get(r, c) > v : String(get(r, c)) > String(v))); return q; },
      lt(c, v) { f.push(r => get(r, c) != null && (typeof v === 'number' ? get(r, c) < v : String(get(r, c)) < String(v))); return q; },
      is(c, v) { f.push(r => v === null ? (get(r, c) === null || get(r, c) === undefined) : get(r, c) === v); return q; },
      not(c, op, v) { if (op === 'is' && v === null) f.push(r => get(r, c) !== null && get(r, c) !== undefined); else if (op === 'eq') f.push(r => get(r, c) !== v); return q; },
      range(a, b) { lo = a; hi = b; return q; },
      upsert(rows, o) { ups = { rows: Array.isArray(rows) ? rows : [rows], key: (o && o.onConflict) || 'id' }; return q; },
      maybeSingle() { single = true; return q; }, single() { single = true; return q; },
      insert(rows) { ins = Array.isArray(rows) ? rows : [rows]; return q; }, update(p) { patch = p; return q; }, delete() { del = true; return q; },
      then(res) {
        tables[t] = tables[t] || [];
        if (ups) {   // insert-or-merge on the conflict column, merging only the columns supplied (as PostgREST does)
          for (const r of ups.rows) { const hit = tables[t].find(x => x[ups.key] === r[ups.key]); if (hit) Object.assign(hit, r); else tables[t].push({ id: `${t}-${tables[t].length + 1}`, ...r }); }
          return res({ data: null, error: null });
        }
        if (ins) {
          if (db.failInsertIf && ins.some(r => db.failInsertIf(t, r))) return res({ data: null, error: { code: 'XX000', message: 'simulated failure' } });
          if (db.failNextInsertOn === t) { db.failNextInsertOn = null; return res({ data: null, error: { code: 'XX000', message: 'simulated failure' } }); }
          if (t === 'coop_journal_entries' && db.raceOnce) {
            db.raceOnce = false;   // a concurrent payment grabs the number this insert was about to use
            tables[t].push({ id: 'race-' + ins[0].entry_number, coop_id: ins[0].coop_id, entry_number: ins[0].entry_number, entry_type: 'manual', description: '(concurrent payment)' });
          }
          const cols = unique[t];
          for (const r of ins) if (cols && cols.every(c => r[c] != null) && tables[t].some(x => cols.every(c => x[c] === r[c])))
            return res({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } });
          const stored = ins.map((r, i) => ({ id: `${t}-${tables[t].length + i + 1}`, ...((opts.defaults && opts.defaults[t]) ? opts.defaults[t]() : {}), ...r }));   // column defaults, like the real DB's now()
          tables[t].push(...stored);
          return res({ data: single ? stored[0] : stored, error: null });
        }
        if (patch) { const hit = tables[t].filter(r => f.every(fn => fn(r))); hit.forEach(r => Object.assign(r, patch)); return res({ data: selAfter ? hit : null, error: null }); }
        if (del) { const keep = tables[t].filter(r => !f.every(fn => fn(r))); tables[t].length = 0; tables[t].push(...keep); return res({ data: null, error: null }); }
        let rows = tables[t].filter(r => f.every(fn => fn(r)));
        if (ord.length) rows = [...rows].sort((a, b) => { for (const [c, asc] of ord) { const x = a[c], y = b[c]; const d = (typeof x === 'number' && typeof y === 'number') ? x - y : String(x).localeCompare(String(y)); if (d) return d * (asc ? 1 : -1); } return 0; });
        if (lim !== null) rows = rows.slice(0, lim); else if (lo !== null) rows = rows.slice(lo, hi + 1);
        else if (!single) rows = rows.slice(0, 1000);
        // opt-in: return only the selected columns, as PostgREST does for a plain column list
        if (opts.project && selCols && /^[\w\s,]+$/.test(selCols) && selCols.trim() !== '*') {
          const keys = selCols.split(',').map(k => k.trim()).filter(Boolean);
          rows = rows.map(r => Object.fromEntries(keys.filter(k => k in r).map(k => [k, r[k]])));
        }
        if (single && rows.length > 1) return res({ data: null, error: { code: 'PGRST116', message: 'multiple rows returned' } });
        return res({ data: single ? (rows[0] || null) : rows, error: null });
      } };
    return q; } };
  return db;
}
module.exports = { makeDb };
