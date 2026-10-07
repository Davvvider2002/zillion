/**
 * zillion/backend/tests/test-bank-reconciliation-sources.js
 *
 * "Where this was initiated" for a matched bank-statement line. A line can be matched four ways, and each remembers its source
 * differently - including one that has NO match type at all (a line explained by a journal entry the person posted). The screen once
 * asked the server about the literal word "null" for those and showed "Unknown type null". These tests pin all four ways down, on the
 * server and on the screen's own code.
 * Run: node backend/tests/test-bank-reconciliation-sources.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const FN = path.join(__dirname, '..', 'netlify', 'functions'), LIB = path.join(__dirname, '..', 'lib');
const { makeDb } = require('./helpers/fakeDb');

const STATE = { db: null };
const mock = (lib, exp) => { const p = require.resolve(path.join(LIB, lib)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
mock('supabase', { getServiceClient: () => STATE.db });
mock('validators', { verifyJWT: () => ({ valid: true, payload: { merchant_id: 'M1' } }) });
mock('coopPortalAuth', { resolvePortalSociety: async () => ({ ok: true, society: { coop_id: 'C1', merchant_id: 'M1' } }), requirePortalPermission: async () => true });
mock('coopEntitlements', { hasAddon: async () => true });
const source = (() => { const p = require.resolve(path.join(FN, 'coop-portal-reconciliation-source.js')); delete require.cache[p]; return require(p); })();

let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };

// ═══ 1. THE SERVER ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
STATE.db = makeDb({
  coop_chart_of_accounts: [{ id: 'a1010', coop_id: 'C1', account_code: '1010', account_name: 'Bank Account' }, { id: 'a4000', coop_id: 'C1', account_code: '4000', account_name: 'Other Income' }],
  coop_journal_entries: [{ id: 'E1', coop_id: 'C1', entry_number: 7, entry_date: '2026-10-05', description: 'Bank interest not previously recorded', entry_type: 'manual', created_by: 'portal' }, { id: 'E-OTHER', coop_id: 'C2', entry_number: 1, entry_date: '2026-10-05', description: 'someone else', entry_type: 'manual' }],
  coop_journal_entry_lines: [{ id: 'L1', journal_entry_id: 'E1', coop_id: 'C1', account_id: 'a1010', line_type: 'debit', amount: 4200 }, { id: 'L2', journal_entry_id: 'E1', coop_id: 'C1', account_id: 'a4000', line_type: 'credit', amount: 4200 }],
});
const get = (type, id) => source.handler({ httpMethod: 'GET', headers: { authorization: 'Bearer x' }, queryStringParameters: { type, id } }).then(r => ({ status: r.statusCode, ...JSON.parse(r.body) }));
(async () => {
  let r = await get('resolved_entry', 'E1');
  ok('a line explained by posting a journal entry can be traced: the entry, its date, description and both sides', r.status === 200 && r.entry_number === 7 && r.description === 'Bank interest not previously recorded' && r.lines.length === 2 && r.lines.find(l => l.side === 'Dr').account_code === '1010' && r.lines.find(l => l.side === 'Cr').account_name === 'Other Income');
  ok('...and it says so plainly: this is the entry YOU posted to explain the line', r.explained_by_you === true);
  r = await get('journal_entry', 'L1');
  ok('an automatic match to a books entry is unchanged (found by the journal LINE) and is not described as "yours"', r.status === 200 && r.entry_number === 7 && r.explained_by_you === false);
  ok('another society\'s entry cannot be read through this', (await get('resolved_entry', 'E-OTHER')).status === 404);
  r = await get('resolved_entry', 'E-GONE');
  ok('if the explaining entry was since deleted the answer is a clear 404 saying so, not a crash', r.status === 404 && /no longer exists/.test(r.error));
  for (const [t, i] of [['null', 'null'], ['undefined', 'x'], ['journal_entry', 'null'], ['resolved_entry', 'undefined']]) {
    r = await get(t, i);
    ok(`type="${t}" id="${i}" (what a line with no source used to send): a plain explanation, never "Unknown type"`, r.status === 400 && /no record was linked/.test(r.error) && !/Unknown type/.test(r.error));
  }
  ok('a genuinely unknown type is still named, with every valid type listed', /Unknown type "banana"/.test((await get('banana', 'x')).error) && /resolved_entry/.test((await get('banana', 'x')).error) && /group/.test((await get('banana', 'x')).error));
  ok('missing parameters are still a 400', (await source.handler({ httpMethod: 'GET', headers: { authorization: 'Bearer x' }, queryStringParameters: {} })).statusCode === 400);

  // ═══ 2. THE SCREEN'S OWN CODE ═══════════════════════════════════════════════════════════════════════════════════════════
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'coop-admin', 'index.html'), 'utf8');
  const grab = name => { const m = html.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}\\n`)); if (!m) throw new Error('screen function not found: ' + name); return m[0]; };
  const ctx = { notified: [], notify(...a) { this.notified.push(a); } };
  vm.createContext(ctx);
  vm.runInContext(['reconciliationSourceFor', 'reconMatchedClick', 'reconMatchedPill'].map(grab).join('\n'), ctx);
  const src = l => vm.runInContext(`reconciliationSourceFor(${JSON.stringify(l)})`, ctx);
  const click = l => vm.runInContext(`reconMatchedClick(${JSON.stringify(l)})`, ctx);
  const pill = l => vm.runInContext(`reconMatchedPill(${JSON.stringify(l)})`, ctx);

  ok('screen: matched to ONE record -> asks for that record by its type and id', JSON.stringify(src({ id: 'L', matched_type: 'loan_disbursement', matched_id: 'LOAN1' })) === '{"type":"loan_disbursement","id":"LOAN1"}');
  ok('screen: matched as a GROUP -> keyed by the bank line itself', JSON.stringify(src({ id: 'LINE9', matched_type: 'group', matched_id: null })) === '{"type":"group","id":"LINE9"}');
  ok('screen: explained by a journal entry (no match type) -> asks for the ENTRY that explained it - the case that broke', JSON.stringify(src({ id: 'L', matched_type: null, matched_id: null, resolved_journal_entry_id: 'E1' })) === '{"type":"resolved_entry","id":"E1"}');
  ok('screen: matched to nothing recorded -> no source (null), so the screen can say so', src({ id: 'L', matched_type: null, matched_id: null, resolved_journal_entry_id: null }) === null);
  ok('screen: a line with a type but no id (corrupt) is also "no source" rather than a request for "undefined"', src({ id: 'L', matched_type: 'loan_repayment', matched_id: null }) === null);
  ok('screen: the click for a line with no source explains why instead of calling the server', /notify\(/.test(click({ id: 'L' })) && !/openReconciliationSourceModal/.test(click({ id: 'L' })));
  ok('screen: the click for a journalled line opens the right dialog', click({ id: 'L', resolved_journal_entry_id: 'E1' }) === "openReconciliationSourceModal('resolved_entry','E1')");

  // EXHAUSTIVE: whatever combination a line is in, the screen never asks the server about "null" or "undefined"
  const vals = [null, undefined, '', 'x'], types = [null, undefined, '', 'group', 'loan_disbursement', 'journal_entry', 'flutterwave_settlement'];
  let combos = 0, leaks = 0;
  for (const matched_type of types) for (const matched_id of vals) for (const resolved_journal_entry_id of vals) {
    combos++;
    const c = click({ id: 'LINE', matched_type, matched_id, resolved_journal_entry_id });
    if (/openReconciliationSourceModal\('(null|undefined|)',|,'(null|undefined|)'\)/.test(c)) leaks++;
  }
  ok(`screen: across all ${combos} combinations of a line's match fields, NOT ONE ever asks the server about "null", "undefined" or nothing`, combos === 112 && leaks === 0);

  ok('screen: the three kinds of match are labelled differently so they can be told apart', /entries/.test(pill({ matched_type: 'group', group_components: [1, 2, 3] })) && /3 entries/.test(pill({ matched_type: 'group', group_components: [1, 2, 3] })) && /journalled/.test(pill({ matched_type: null, resolved_journal_entry_id: 'E1' })) && !/journalled|entries/.test(pill({ matched_type: 'loan_disbursement', matched_id: 'x' })));

  // the two lines that exist in production today
  const prodShape = [{ id: 'a', match_status: 'matched', matched_type: null, matched_id: null, resolved_journal_entry_id: 'EP1' }, { id: 'b', match_status: 'matched', matched_type: null, matched_id: null, resolved_journal_entry_id: 'EP2' }, { id: 'c', match_status: 'matched', matched_type: 'loan_disbursement', matched_id: 'LN', resolved_journal_entry_id: null }];
  ok('the real-world shapes (two journalled lines and a loan match, as in production now) all open a sensible dialog', prodShape.every(l => /openReconciliationSourceModal\('(resolved_entry|loan_disbursement)','[A-Za-z0-9]+'\)/.test(click(l))));
  ok('guard: the old unsafe call (matched_type and matched_id straight into the dialog) no longer exists on the screen', !/openReconciliationSourceModal\('\$\{l\.matched_type\}','\$\{l\.matched_id\}'\)/.test(html));
})().catch(e => { console.log('FAIL - threw: ' + e.stack); bad++; process.exitCode = 1; });

process.on('exit', () => { if (!bad) console.log('\nAll reconciliation source tests passed.'); });
