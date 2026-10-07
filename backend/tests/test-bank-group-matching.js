/**
 * zillion/backend/tests/test-bank-group-matching.js
 *
 * Matching ONE bank line to SEVERAL recorded entries. Grouping is a person's decision that overrides the exact one-to-one rule, so
 * the tests are about the ways it could go wrong: a total that is a kobo out, a record that does not belong to this bank line or
 * this society, two people racing for the same line or the same record, and an undo that leaves a mess.
 * Run: node backend/tests/test-bank-group-matching.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const FN = path.join(__dirname, '..', 'netlify', 'functions'), LIB = path.join(__dirname, '..', 'lib');
const { makeDb } = require('./helpers/fakeDb');

const STATE = { db: null, addon: true, perm: true, permCalls: [], audit: [] };
const mock = (lib, exp) => { const p = require.resolve(path.join(LIB, lib)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
mock('supabase', { getServiceClient: () => STATE.db });
mock('validators', { verifyJWT: () => ({ valid: true, payload: { merchant_id: 'M1', role: 'merchant' } }) });
mock('coopPortalAuth', { resolvePortalSociety: async () => ({ ok: true, society: { coop_id: 'C1', merchant_id: 'M1' } }), requirePortalPermission: async (db, auth, domain, action) => { STATE.permCalls.push([domain, action]); return STATE.perm; } });
mock('coopEntitlements', { hasAddon: async () => STATE.addon });
mock('auditLog', { auditLog: async (db, o) => { STATE.audit.push(o); } });

const load = f => { const p = require.resolve(path.join(FN, f)); delete require.cache[p]; return require(p); };
const G = require(path.join(LIB, 'coopBankGroupMatch'));

let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };

// ═══ 1. SUGGESTIONS (they only save effort; they match nothing) ═══════════════════════════════════════════════════════════
const cand = (id, amountKobo, date = '2026-10-05') => ({ type: 'journal_entry', id, amountKobo, date, description: 'entry ' + id });
let s = G.suggestGroups(700000, [cand('a', 200000), cand('b', 350000), cand('c', 150000), cand('d', 999), cand('e', 500000), cand('f', 120000)]);
ok('suggestions: finds the combination that adds up EXACTLY (2,000 + 3,500 + 1,500 = 7,000)', s.some(g => g.map(x => x.id).sort().join() === 'a,b,c'));
ok('suggestions: every suggestion adds up exactly to the target, never approximately', s.every(g => g.reduce((t, x) => t + [cand('a', 200000), cand('b', 350000), cand('c', 150000), cand('d', 999), cand('e', 500000), cand('f', 120000)].find(c => c.id === x.id).amountKobo, 0) === 700000));
s = G.suggestGroups(700000, [cand('a', 700000), cand('b', 200000), cand('c', 500000)]);
ok('suggestions: the fewest records come first (one entry of 7,000 beats 2,000 + 5,000)', s[0].length === 1 && s[0][0].id === 'a' && s[1].length === 2);
ok('suggestions: nothing is suggested when nothing adds up', G.suggestGroups(700001, [cand('a', 200000), cand('b', 350000), cand('c', 150000)]).length === 0);
ok('suggestions: entries bigger than the whole bank line are never part of one', !G.suggestGroups(100, [cand('big', 5000), cand('x', 60), cand('y', 40)]).some(g => g.some(x => x.id === 'big')));
const many = Array.from({ length: 40 }, (_, i) => cand('m' + i, 100003 + i * 7));
const t0 = Date.now(); const none = G.suggestGroups(7777777, many);
ok('suggestions: a hopeless search over many records ends quickly (bounded) - it can never hang a request', Date.now() - t0 < 1500 && Array.isArray(none));
ok('suggestions: only groups of at most 8 are offered', G.suggestGroups(900, Array.from({ length: 12 }, (_, i) => cand('s' + i, 100)), { maxSize: 8 }).length === 0);

// ═══ 2. THE FIXTURE: books with three deposits, and one bank line for all of them ═════════════════════════════════════════════
const CHART = [['1010', 'Bank Account', 'ASSET', 'bank_cash', 'a1010'], ['2300', 'ZENITH BANK', 'ASSET', 'bank_cash', 'a2300'], ['4000', 'Other Income', 'INCOME', 'direct_income', 'a4000'], ['5000', 'Office Expenses', 'EXPENSE', 'indirect_expenses', 'a5000']]
  .map(([code, name, type, sub, id]) => ({ id, coop_id: 'C1', account_code: code, account_name: name, account_type: type, sub_type: sub, active: true }));
const rejected = error => { const q = { select() { return q; }, single() { return q; }, then(res) { return res({ data: null, error }); } }; return q; };
let seq = 0;
function fresh() {
  STATE.addon = true; STATE.perm = true; STATE.permCalls = []; STATE.audit = []; seq = 0;
  const d = makeDb({ coop_societies: [{ coop_id: 'C1', name: 'Test Coop', settlement_account_code: '1010', settlement_bank_code: '057', settlement_account_number: '0123456789', settlement_account_name: 'Test Coop Ltd' }, { coop_id: 'C2', name: 'Other Coop' }],
    coop_chart_of_accounts: CHART.map(a => ({ ...a })), coop_journal_entries: [{ id: 'OPEN', coop_id: 'C1', entry_number: 1, entry_type: 'opening_balance', entry_date: '2026-09-01' }], coop_journal_entry_lines: [],
    coop_flutterwave_ledger: [], coop_loans: [], coop_loan_repayments: [], coop_bank_reconciliation_batches: [], coop_bank_statement_lines: [], coop_reconciliation_unmatched_records: [], coop_bank_statement_line_matches: [] },
    { defaults: { coop_bank_statement_lines: () => ({ id: require('crypto').randomUUID() }), coop_bank_reconciliation_batches: () => ({ id: require('crypto').randomUUID() }) } });   // real UUIDs, as Postgres generates
  d.rpc = async (fn, a) => {
    if (fn !== 'coop_account_movements') return { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
    const acct = d.tables.coop_chart_of_accounts.find(x => x.coop_id === a.p_coop_id && x.account_code === a.p_account_code);
    const rows = d.tables.coop_journal_entry_lines.filter(l => acct && l.account_id === acct.id && l.coop_id === a.p_coop_id).map(l => ({ l, e: d.tables.coop_journal_entries.find(x => x.id === l.journal_entry_id) }))
      .filter(({ e }) => e.entry_type !== 'opening_balance' && e.entry_date >= a.p_from && e.entry_date <= a.p_to)
      .map(({ l, e }) => ({ line_id: l.id, entry_id: e.id, entry_number: e.entry_number, entry_date: e.entry_date, description: e.description, entry_type: e.entry_type, created_by: e.created_by, line_type: String(l.line_type).toLowerCase(), amount_kobo: l.amount, flw_linked: false }));
    return { data: rows, error: null };
  };
  const from = d.from.bind(d);
  d.from = t => {          // the database's unique index on (batch, component), checked atomically at commit
    const q = from(t);
    if (t === 'coop_bank_statement_line_matches') {
      const ins = q.insert.bind(q);
      q.insert = rows => { const inner = ins(rows); return { then(res, rej) {
        if (d.failLinks) return res({ data: null, error: { code: 'XX000', message: 'disk full' } });
        const list = Array.isArray(rows) ? rows : [rows], have = d.tables.coop_bank_statement_line_matches;
        if (list.some(r => have.some(h => h.batch_id === r.batch_id && h.component_type === r.component_type && h.component_id === r.component_id))) return res({ data: null, error: { code: '23505', message: 'duplicate key' } });
        return inner.then(res, rej); } }; };
    }
    return q;
  };
  STATE.db = d; return d;
};
const book = (date, description, side, amount, { bank = 'a1010', coop = 'C1' } = {}) => {
  const T = STATE.db.tables, id = 'E' + (++seq), line = 'BL' + seq;
  T.coop_journal_entries.push({ id, coop_id: coop, entry_number: 100 + seq, entry_date: date, description, entry_type: 'manual', created_by: 'portal' });
  T.coop_journal_entry_lines.push({ id: line, journal_entry_id: id, coop_id: coop, account_id: bank, line_type: side, amount }, { id: line + 'x', journal_entry_id: id, coop_id: coop, account_id: 'a4000', line_type: side === 'debit' ? 'credit' : 'debit', amount });
  return line;
};
const recon = load('coop-portal-reconcile-bank-statement.js'), ep = load('coop-portal-bank-statement-group-match.js'), history = load('coop-portal-bank-reconciliation-history.js'), source = load('coop-portal-reconciliation-source.js');
const upload = (lines, extra = {}) => recon.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer x' }, body: JSON.stringify({ filename: 's.csv', bank_account_id: 'a1010', lines, ...extra }) }).then(r => ({ status: r.statusCode, ...JSON.parse(r.body) }));
const get = id => ep.handler({ httpMethod: 'GET', headers: { authorization: 'Bearer x' }, queryStringParameters: { statement_line_id: id } }).then(r => ({ status: r.statusCode, ...JSON.parse(r.body) }));
const post = b => ep.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer x' }, body: JSON.stringify(b) }).then(r => ({ status: r.statusCode, ...JSON.parse(r.body) }));
const comp = ids => ids.map(id => ({ type: 'journal_entry', id }));
const lineBy = amt => STATE.db.tables.coop_bank_statement_lines.find(l => l.amount_kobo === amt);
const T = () => STATE.db.tables;

/** three deposits of 2,000 / 3,500 / 1,500 recorded over three days, one batch deposit of 7,000 on the statement, plus noise */
async function scenario() {
  fresh();
  const A = book('2026-10-05', 'Meeting dues Oct 5', 'debit', 200000), B = book('2026-10-06', 'Meeting dues Oct 6', 'debit', 350000), C = book('2026-10-07', 'Savings cash Oct 7', 'debit', 150000);
  const OUT = book('2026-10-06', 'Rent paid', 'credit', 70000), FAR = book('2026-09-01', 'Old deposit', 'debit', 90000), OTHER = book('2026-10-06', 'Deposit into Zenith', 'debit', 111000, { bank: 'a2300' });
  const up = await upload([{ date: '2026-10-01', amount_kobo: 5, description: 'start marker', direction: 'credit' }, { date: '2026-10-08', amount_kobo: 700000, description: 'BATCH CASH DEPOSIT BRANCH', direction: 'credit' }, { date: '2026-10-20', amount_kobo: 1, description: 'end marker', direction: 'credit' }], { opening_balance_kobo: 0, closing_balance_kobo: 700006 });
  return { A, B, C, OUT, FAR, OTHER, up, lineId: lineBy(700000).id, batchId: up.batch_id };
}

(async () => {
  let f = await scenario();
  ok('setup: the 7,000 batch deposit cannot be matched automatically (no single entry equals it) and is left unmatched', lineBy(700000).match_status === 'unmatched' && f.up.unmatched_lines.some(l => l.amountKobo === 700000));
  ok('setup: the three deposits ARE on the "recorded but not found on the statement" list before grouping (so leaving it later means something)', [f.A, f.B, f.C].every(id => T().coop_reconciliation_unmatched_records.some(x => x.record_id === id)));

  // ═══ 3. WHAT CAN BE GROUPED ═══════════════════════════════════════════════════════════════════════════════════════════════
  let g = await get(f.lineId);
  ok('candidates: the three deposits recorded that week are offered (and nothing else of the right direction nearby)', g.status === 200 && g.candidates.map(c => c.id).sort().join() === [f.A, f.B, f.C].sort().join());
  ok('candidates: money OUT (rent), other bank accounts (Zenith) and entries a month away are NOT offered', !g.candidates.some(c => [f.OUT, f.OTHER, f.FAR].includes(c.id)));
  ok('candidates: nearest in time first, each with date, amount and description', g.candidates[0].id === f.C && g.candidates.every(c => c.date && c.amount_kobo > 0 && c.description));
  ok('suggestions: the combination that adds up exactly is already worked out for the person', g.suggestions.some(s => s.map(x => x.id).sort().join() === [f.A, f.B, f.C].sort().join()));
  ok('the bank line and its bank account are described', g.line.amount_kobo === 700000 && g.line.direction === 'credit' && g.bank_account.code === '1010');
  ok('reading is allowed with plain view access; changing needs the create permission', STATE.permCalls[STATE.permCalls.length - 1][1] === undefined);

  // ═══ 4. CONFIRMING, AND EVERYTHING THAT MUST BE REFUSED ═══════════════════════════════════════════════════════════════════
  const unchanged = async why => ok(`${why}: nothing was written - the line is still unmatched, no group exists, the books are untouched`, lineBy(700000).match_status === 'unmatched' && T().coop_bank_statement_line_matches.length === 0 && lineBy(700000).matched_type === null);
  let r = await post({ action: 'confirm', statement_line_id: f.lineId, components: comp([f.A, f.B]) });
  ok('refused: entries that add up to 5,500 for a 7,000 bank line - and it says how far short', r.status === 400 && /5,500\.00/.test(r.error) && /7,000\.00/.test(r.error) && /short by ₦1,500\.00/.test(r.error)); await unchanged('short');
  r = await post({ action: 'confirm', statement_line_id: f.lineId, components: comp([f.A, f.B, f.C, ]).concat([{ type: 'journal_entry', id: f.FAR }]) });
  ok('refused: an extra entry that is not available for this line (a month old)', r.status === 409); await unchanged('unavailable entry');
  r = await post({ action: 'confirm', statement_line_id: f.lineId, components: comp([f.A, f.B, f.C, f.OUT]) });
  ok('refused: a money-OUT entry cannot help explain a money-IN bank line', r.status === 409); await unchanged('wrong direction');
  r = await post({ action: 'confirm', statement_line_id: f.lineId, components: comp([f.A, f.B, f.OTHER]) });
  ok('refused: an entry from a different bank account (Zenith) is not a candidate for this account\'s statement', r.status === 409); await unchanged('other account');
  r = await post({ action: 'confirm', statement_line_id: f.lineId, components: comp([f.A, f.B, f.C, 'invented-id-1']) });
  ok('refused: an id the server never offered (invented) is not accepted', r.status === 409); await unchanged('invented id');
  const foreign = book('2026-10-06', 'Another society deposit', 'debit', 100000, { coop: 'C2' });
  r = await post({ action: 'confirm', statement_line_id: f.lineId, components: comp([f.A, f.B, f.C, foreign]) });
  ok('refused: another society\'s entry cannot be smuggled in', r.status === 409); await unchanged('foreign entry');
  r = await post({ action: 'confirm', statement_line_id: f.lineId, components: comp([f.A, f.A, f.B, f.C]) });
  ok('refused: the same entry chosen twice', r.status === 400 && /twice/.test(r.error)); await unchanged('duplicate');
  ok('refused: nothing chosen, malformed items, and absurdly many', (await post({ action: 'confirm', statement_line_id: f.lineId, components: [] })).status === 400 && (await post({ action: 'confirm', statement_line_id: f.lineId, components: [{ type: 'journal_entry' }] })).status === 400
    && (await post({ action: 'confirm', statement_line_id: f.lineId, components: Array.from({ length: 31 }, (_, i) => ({ type: 'journal_entry', id: 'x' + i })) })).status === 400);
  ok('refused: a missing or malformed statement line id, an unknown action', (await post({ action: 'confirm', components: comp([f.A]) })).status === 400 && (await post({ action: 'confirm', statement_line_id: 'not-a-uuid', components: comp([f.A]) })).status === 400 && (await post({ action: 'dance', statement_line_id: f.lineId })).status === 400);
  ok('refused: a statement line that does not exist (or belongs to another society) is a 404', (await post({ action: 'confirm', statement_line_id: '00000000-0000-4000-8000-000000000000', components: comp([f.A]) })).status === 404);
  STATE.perm = false; ok('refused: without the reconciliation "create" permission (and it asked for exactly that)', (await post({ action: 'confirm', statement_line_id: f.lineId, components: comp([f.A, f.B, f.C]) })).status === 403 && STATE.permCalls[STATE.permCalls.length - 1][1] === 'create'); STATE.perm = true;
  STATE.addon = false; ok('refused: without the Bank Reconciliation add-on', (await post({ action: 'confirm', statement_line_id: f.lineId, components: comp([f.A, f.B, f.C]) })).status === 403); STATE.addon = true;
  const extra = book('2026-10-07', 'Extra deposit that is NOT part of this bank line', 'debit', 100000);
  r = await post({ action: 'confirm', statement_line_id: f.lineId, components: comp([f.A, f.B, f.C, extra]) });
  ok('refused: an entry too many (total 8,000 for a 7,000 line) is reported as OVER, by exactly how much', r.status === 400 && /8,000\.00/.test(r.error) && /over by ₦1,000\.00/.test(r.error)); await unchanged('over');

  // the confirmation itself
  r = await post({ action: 'confirm', statement_line_id: f.lineId, components: comp([f.A, f.B, f.C]) });
  ok('CONFIRMED: three entries (2,000 + 3,500 + 1,500) matched to the 7,000 bank line', r.status === 200 && r.success && r.total_kobo === 700000 && r.components.length === 3);
  ok('the bank line is now matched as a group, keeping its own direction (so the closing balance counts it)', lineBy(700000).match_status === 'matched' && lineBy(700000).matched_type === 'group' && lineBy(700000).matched_id === null && lineBy(700000).direction === 'credit');
  ok('each component is recorded with a snapshot of what it was and who confirmed it', T().coop_bank_statement_line_matches.length === 3 && T().coop_bank_statement_line_matches.every(m => m.statement_line_id === f.lineId && m.matched_by === 'M1' && m.record_date && m.description && m.amount_kobo > 0));
  ok('the upload\'s matched count is kept honest (the one grouped line is now counted as matched)', T().coop_bank_reconciliation_batches[0].matched_lines === 1);
  ok('the three entries leave the "recorded but not found on the statement" list', !T().coop_reconciliation_unmatched_records.some(x => [f.A, f.B, f.C].includes(x.record_id)));
  ok('it leaves a trail: who matched which entries to which bank line, with the total', STATE.audit.some(a => a.action === 'COOP_BANK_STATEMENT_GROUP_MATCHED' && a.resourceId === f.lineId && a.requestBody.total_kobo === 700000 && a.requestBody.components.length === 3));
  r = await post({ action: 'confirm', statement_line_id: f.lineId, components: comp([f.A, f.B, f.C]) });
  ok('confirming the same line again is refused - it is already matched', r.status === 409 && /already matched/.test(r.error));
  g = await get(f.lineId);
  ok('and a matched line has no more candidates to offer (409)', g.status === 409);

  // ═══ 5. THE SUMMARY AND THE EXPLANATION ═══════════════════════════════════════════════════════════════════════════════════
  const hist = await history.handler({ httpMethod: 'GET', headers: { authorization: 'Bearer x' }, queryStringParameters: { batch_id: f.batchId } }).then(x => ({ status: x.statusCode, ...JSON.parse(x.body) }));
  const gl = hist.lines.find(l => l.amount_kobo === 700000);
  ok('history: the grouped line lists its components so the screen can show them', gl.matched_type === 'group' && gl.group_components.length === 3 && gl.group_components.reduce((t, c) => t + c.amount_kobo, 0) === 700000);
  ok('history: the grouped line counts toward the closing balance (credits 7,000 -> computed closing 7,000.00)', hist.summary.total_credits_kobo === 700000 && hist.summary.computed_closing_balance_kobo === 700000);
  const src = (type, id) => source.handler({ httpMethod: 'GET', headers: { authorization: 'Bearer x' }, queryStringParameters: { type, id } }).then(x => ({ status: x.statusCode, ...JSON.parse(x.body) }));
  let sr = await src('group', f.lineId);
  ok('source: a grouped line explains itself - the bank line, who confirmed it, and every entry in it', sr.status === 200 && sr.components.length === 3 && sr.amount_kobo === 700000 && sr.matched_by === 'M1' && sr.components.reduce((t, c) => t + c.amount_kobo, 0) === 700000);
  ok('source: a line that is not a group match (or not ours) is a 404', (await src('group', T().coop_bank_statement_lines.find(l => l.amount_kobo === 1).id)).status === 404);

  // ═══ 6. UNDO ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
  r = await post({ action: 'unmatch', statement_line_id: f.lineId });
  ok('UNDO: the bank line is unmatched again and the group is gone', r.status === 200 && r.released === 3 && lineBy(700000).match_status === 'unmatched' && lineBy(700000).matched_type === null && T().coop_bank_statement_line_matches.length === 0);
  ok('UNDO: the three entries are "recorded but not found on the statement" again, exactly as before the group', [f.A, f.B, f.C].every(id => T().coop_reconciliation_unmatched_records.some(x => x.record_id === id && x.record_type === 'journal_entry')));
  ok('UNDO: the upload\'s matched count is restored and the undo is on the record', T().coop_bank_reconciliation_batches[0].matched_lines === 0 && STATE.audit.some(a => a.action === 'COOP_BANK_STATEMENT_GROUP_UNMATCHED'));
  ok('UNDO: undoing twice is refused, and so is undoing a line that was never a group', (await post({ action: 'unmatch', statement_line_id: f.lineId })).status === 409 && (await post({ action: 'unmatch', statement_line_id: lineBy(1).id })).status === 409);
  r = await post({ action: 'confirm', statement_line_id: f.lineId, components: comp([f.A, f.B, f.C]) });
  ok('...and after an undo the same entries can be grouped again', r.status === 200);

  // ═══ 7. TWO PEOPLE AT ONCE ═══════════════════════════════════════════════════════════════════════════════════════════════
  f = await scenario();
  let both = await Promise.all([post({ action: 'confirm', statement_line_id: f.lineId, components: comp([f.A, f.B, f.C]) }), post({ action: 'confirm', statement_line_id: f.lineId, components: comp([f.A, f.B, f.C]) })]);
  ok('two people confirming the SAME line at the same instant: exactly one wins, the other is told it was just matched', both.filter(x => x.status === 200).length === 1 && both.filter(x => x.status === 409).length === 1);
  ok('...and the data holds ONE group of three, not two', T().coop_bank_statement_line_matches.length === 3 && lineBy(700000).matched_type === 'group');

  f = await scenario();
  await upload([{ date: '2026-10-01', amount_kobo: 6, description: 'start 2', direction: 'credit' }, { date: '2026-10-08', amount_kobo: 700000, description: 'SECOND DEPOSIT FOR THE SAME MONEY', direction: 'credit' }, { date: '2026-10-20', amount_kobo: 2, description: 'end marker 2', direction: 'credit' }], {});
  const batch1 = T().coop_bank_reconciliation_batches[0].id;
  const l2 = T().coop_bank_statement_lines.filter(l => l.amount_kobo === 700000).find(l => l.id !== f.lineId);
  // both lines now sit in ONE upload, competing for the very same three entries
  T().coop_bank_statement_lines.find(l => l.id === l2.id).batch_id = batch1;
  both = await Promise.all([post({ action: 'confirm', statement_line_id: f.lineId, components: comp([f.A, f.B, f.C]) }), post({ action: 'confirm', statement_line_id: l2.id, components: comp([f.B, f.C, f.A]) })]);
  ok('two DIFFERENT lines racing for the same entries in one upload: one wins; the database refuses to let an entry explain two things', both.filter(x => x.status === 200).length <= 1 && T().coop_bank_statement_line_matches.length <= 3);
  const loser = both.find(x => x.status !== 200);
  ok('...and the loser is cleanly refused, leaving its line unmatched (not half-matched)', loser && loser.status === 409 && T().coop_bank_statement_lines.filter(l => l.matched_type === 'group').length === 1);

  f = await scenario(); STATE.db.failLinks = true;
  r = await post({ action: 'confirm', statement_line_id: f.lineId, components: comp([f.A, f.B, f.C]) });
  ok('a failure while saving the group (disk full) is reported, and the line is put back exactly as it was', r.status === 500 && lineBy(700000).match_status === 'unmatched' && lineBy(700000).matched_type === null && T().coop_bank_statement_line_matches.length === 0);
  STATE.db.failLinks = false;

  // ═══ 8. USED RECORDS ARE NOT OFFERED AGAIN ═══════════════════════════════════════════════════════════════════════════════
  f = await scenario();
  await post({ action: 'confirm', statement_line_id: f.lineId, components: comp([f.A, f.B]) });   // 5,500 - refused, so nothing used
  T().coop_bank_statement_line_matches.push({ id: 'pre', coop_id: 'C1', statement_line_id: 'other', batch_id: f.batchId, component_type: 'journal_entry', component_id: f.B, amount_kobo: 350000 });
  g = await get(f.lineId);
  ok('an entry already used by another group in this upload is no longer offered', !g.candidates.some(c => c.id === f.B) && g.candidates.some(c => c.id === f.A));
  r = await post({ action: 'confirm', statement_line_id: f.lineId, components: comp([f.A, f.B, f.C]) });
  ok('...and cannot be sneaked in by id either', r.status === 409);

  // ═══ 9. A GROUP OF ONE: a person confirming a match the 3-day window would not make ═════════════════════════════════════
  fresh(); const lone = book('2026-10-01', 'Cheque deposit', 'debit', 480000);
  const up = await upload([{ date: '2026-10-11', amount_kobo: 480000, description: 'CHEQUE CLEARED', direction: 'credit' }, { date: '2026-10-25', amount_kobo: 3, description: 'end', direction: 'credit' }]);
  const loneLine = lineBy(480000);
  ok('setup: a cheque banked on the 1st but cleared on the 11th is outside the automatic 3-day window', loneLine.match_status === 'unmatched');
  g = await get(loneLine.id);
  ok('it is offered, and suggested as a single entry that matches exactly', g.candidates.some(c => c.id === lone) && g.suggestions.some(s => s.length === 1 && s[0].id === lone));
  r = await post({ action: 'confirm', statement_line_id: loneLine.id, components: comp([lone]) });
  ok('a person can confirm that one entry IS this bank line - exact amount still required', r.status === 200 && lineBy(480000).matched_type === 'group');

  // ═══ 10. THE GUARDS ═════════════════════════════════════════════════════════════════════════════════════════════════════
  const lib = fs.readFileSync(path.join(LIB, 'coopBankGroupMatch.js'), 'utf8'), epSrc = fs.readFileSync(path.join(FN, 'coop-portal-bank-statement-group-match.js'), 'utf8');
  ok('guard: the total must equal the bank line exactly - there is no tolerance', /if \(total !== line\.amount_kobo\)/.test(lib));
  ok('guard: the records come from the SERVER\'s candidates, never from the request', /available\.get\(k\)/.test(lib) && !/amountKobo: c\.amount/.test(epSrc));
  ok('guard: the line is claimed only if it is still unmatched', /\.eq\('match_status', 'unmatched'\)\.select\('id'\)/.test(lib));
  ok('guard: changing anything needs the create permission', /writing \? 'create' : undefined/.test(epSrc));
})().catch(e => { console.log('FAIL - threw: ' + e.stack); bad++; process.exitCode = 1; });

process.on('exit', () => { if (!bad) console.log('\nAll grouped bank matching tests passed.'); });
