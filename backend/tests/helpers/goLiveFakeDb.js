/**
 * A small in-memory stand-in for the Supabase query builder, enough for the go-live importers and books:
 * select (with count/head), eq, neq, in, order (asc/desc), range, limit, insert (rows or one row, with .select()),
 * update, delete, maybeSingle, single. Unique rules the real database enforces are imitated for journal entry
 * numbers and member numbers.
 */
'use strict';

function fakeDb(seed) {
  const t = JSON.parse(JSON.stringify(seed));
  let n = 0;
  const from = name => {
    t[name] = t[name] || [];
    const st = { f: [], ord: null, lim: null, rng: null, op: 'select', row: null, head: false };
    const rows = () => {
      let r = t[name].filter(x => st.f.every(f => f(x)));
      if (st.ord) r = r.slice().sort((a, b) => (a[st.ord] > b[st.ord] ? 1 : a[st.ord] < b[st.ord] ? -1 : 0) * (st.desc ? -1 : 1));
      if (st.rng) r = r.slice(st.rng[0], st.rng[1] + 1);
      if (st.lim != null) r = r.slice(0, st.lim);
      return r;
    };
    const q = {
      select(_c, o) { if (o && o.head) st.head = true; st.cnt = !!(o && o.count); return q; },
      eq(k, v) { st.f.push(x => x[k] === v); return q; },
      neq(k, v) { st.f.push(x => x[k] !== v); return q; },
      in(k, vs) { st.f.push(x => vs.includes(x[k])); return q; },
      order(k, o) { st.ord = k; st.desc = !!(o && o.ascending === false); return q; }, limit(x) { st.lim = x; return q; }, range(a, b) { st.rng = [a, b]; return q; },
      insert(r) { st.op = 'insert'; st.row = r; return q; }, delete() { st.op = 'delete'; return q; }, update(u) { st.op = 'update'; st.row = u; return q; },
      maybeSingle: async () => ({ data: rows()[0] || null, error: null }),
      single: async () => {
        if (st.op === 'insert') { const r = { id: 'id' + (++n), ...st.row }; t[name].push(r); return { data: r, error: null }; }
        return { data: rows()[0] || null, error: null };
      },
      then(res, rej) {
        let out;
        if (st.op === 'insert') {
          const list = [].concat(st.row).map(r => ({ id: 'id' + (++n), ...r }));
          for (const r of list) {
            if (name === 'coop_journal_entries' && t[name].some(e => e.coop_id === r.coop_id && e.entry_number === r.entry_number)) { out = { data: null, error: { code: '23505', message: 'dup entry number' } }; break; }
            if (name === 'coop_members' && r.member_number && t[name].some(e => e.coop_id === r.coop_id && e.member_number === r.member_number)) { out = { data: null, error: { message: 'duplicate key idx_coop_members_number' } }; break; }
          }
          if (!out) { t[name].push(...list); out = { data: list, error: null }; }
        } else if (st.op === 'delete') { const dead = new Set(rows()); t[name] = t[name].filter(r => !dead.has(r)); out = { error: null }; }
        else if (st.op === 'update') { rows().forEach(r => Object.assign(r, st.row)); out = { error: null }; }
        else if (st.head) out = { count: t[name].filter(x => st.f.every(f => f(x))).length, error: null };
        else out = { data: rows(), error: null };
        return Promise.resolve(out).then(res, rej);
      },
    };
    return q;
  };
  return { from, t: () => t };
}

module.exports = { fakeDb };
