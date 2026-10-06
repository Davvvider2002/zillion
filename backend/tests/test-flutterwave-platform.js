/**
 * zillion/backend/tests/test-flutterwave-platform.js
 *
 * Zillion's cross-society view of Flutterwave collections: totals, who needs attention and why (in plain words), ordering,
 * access control, and that a failure is readable. The per-society numbers are added up by the database
 * (coop_flutterwave_platform_summary, proven separately against staging); here the endpoint's own logic is tested.
 * Run: node backend/tests/test-flutterwave-platform.js
 */
'use strict';
const path = require('path');
const LIB = path.join(__dirname, '..', 'lib'), FN = path.join(__dirname, '..', 'netlify', 'functions');
const { makeDb } = require('./helpers/fakeDb');

process.env.FLW_V3_SECRET_KEY = 'FLWSECK-live-X';
const STATE = { db: null, valid: true, role: true };
const mock = (lib, exp) => { const p = require.resolve(path.join(LIB, lib)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
mock('supabase', { getServiceClient: () => STATE.db });
mock('validators', { verifyJWT: () => ({ valid: STATE.valid, payload: { username: 'ops' } }), requireRole: () => STATE.role });
const ep = require(path.join(FN, 'admin-coop-flutterwave-ledger'));

let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };
const daysAgo = d => new Date(Date.now() - d * 86400000).toISOString();
const row = (coop_id, o = {}) => ({ coop_id, in_kobo: 0, out_kobo: 0, held_kobo: 0, held_count: 0, oldest_held_at: null, owed_kobo: 0, owed_count: 0, last_settlement_at: null, unmatched_settlements: 0, wrong_account_settlements: 0, test_rows: 0, rows_without_journal: 0, gl_kobo: 0, difference_kobo: 0, ...o });
const soc = (coop_id, name, o = {}) => ({ coop_id, name, status: 'ACTIVE', flutterwave_subaccount_id: 'RS_' + coop_id, settlement_account_name: name + ' Ltd', settlement_account_number: '0123456789', settlement_account_code: '1010', ...o });
const setup = (rows, societies, rpcError = null) => { STATE.db = makeDb({ coop_societies: societies }); STATE.db.rpc = async () => rpcError ? { data: null, error: { message: rpcError } } : { data: rows, error: null }; STATE.valid = true; STATE.role = true; };
const get = () => ep.handler({ httpMethod: 'GET', headers: { authorization: 'Bearer x' } }).then(r => ({ status: r.statusCode, ...JSON.parse(r.body) }));

(async () => {
  setup([
    row('A', { in_kobo: 900000, out_kobo: 600000, held_kobo: 300000, held_count: 2, oldest_held_at: daysAgo(9), last_settlement_at: daysAgo(12) }),   // stale
    row('B', { in_kobo: 200000, owed_kobo: 200000, owed_count: 1 }),                                                                                 // owed by Zillion, no bank account on file
    row('C', { in_kobo: 100000, out_kobo: 100000, difference_kobo: 5000, last_settlement_at: daysAgo(1) }),                                          // books disagree
    row('F', { in_kobo: 500000, out_kobo: 500000, last_settlement_at: daysAgo(2) }),                                                                 // perfectly healthy
    row('G', { held_kobo: 10000, held_count: 1, oldest_held_at: daysAgo(1), unmatched_settlements: 1, wrong_account_settlements: 2, rows_without_journal: 3 }),
    row('GHOST', { difference_kobo: 777 }),                                                                                                           // activity for a society that no longer exists
  ], [soc('A', 'Alpha Coop'), soc('B', 'Bravo Coop', { settlement_account_number: null }), soc('C', 'Charlie Coop'), soc('D', 'Delta Coop'), soc('E', 'Echo Coop', { flutterwave_subaccount_id: null }), soc('F', 'Foxtrot Coop'), soc('G', 'Golf Coop')]);
  let r = await get();
  const by = id => r.societies.find(s => s.coop_id === id);
  ok('succeeds and says whether Flutterwave is in live mode', r.status === 200 && r.live_key === true);
  ok('a society never set up for Flutterwave and with no activity is left out; one that is set up but quiet is listed', !by('E') && by('D') && by('D').has_activity === false);
  ok('totals add up across societies: held by Flutterwave', r.totals.held_by_flutterwave_kobo === 310000);
  ok('totals add up across societies: owed by Zillion', r.totals.owed_by_zillion_kobo === 200000);
  ok('totals: collected, settled and the counts', r.totals.collected_kobo === 1700000 && r.totals.settled_kobo === 1200000 && r.totals.societies_listed === 6 && r.totals.societies_with_activity === 5);
  ok('a healthy society has nothing flagged', by('F').attention.length === 0 && by('D').attention.length === 0);
  ok('payments unsettled past 5 days are flagged, with the age', by('A').attention.some(w => /unsettled for more than 5 days/.test(w)) && by('A').oldest_held_days === 9);
  ok('money waiting with no settlement bank account on file is flagged', by('B').attention.some(w => /no settlement bank account/.test(w)));
  ok('a ledger/books disagreement is flagged with the amount in naira', by('C').attention.some(w => /disagree by ₦50\.00/.test(w)));
  ok('unmatched settlements, wrong-account settlements and journal-less rows are each flagged', by('G').attention.length >= 3 && by('G').attention.some(w => /do not match/.test(w)) && by('G').attention.some(w => /different account/.test(w)) && by('G').attention.some(w => /no journal entry/.test(w)));
  ok('societies needing attention are counted', r.totals.societies_needing_attention === 4);
  ok('those needing attention come first, then the most owed/held', r.societies.slice(0, 4).every(s => s.attention.length > 0) && r.societies.slice(4).every(s => s.attention.length === 0) && r.societies[0].coop_id === 'B');
  ok('activity for a society that no longer exists is reported, not silently lost', JSON.stringify(r.orphaned_coop_ids) === '["GHOST"]');
  ok('the owed-by-Zillion amount is shown per society', by('B').owed_by_zillion_kobo === 200000 && by('B').owed_count === 1);

  setup([], [soc('A', 'Alpha Coop')]);
  r = await get();
  ok('before anything has happened: a quiet, healthy list and zero totals - not an error', r.status === 200 && r.totals.held_by_flutterwave_kobo === 0 && r.totals.societies_needing_attention === 0);

  setup([], [], 'permission denied for function');
  r = await get();
  ok('a database failure is a readable 500 saying what failed', r.status === 500 && /platform summary/.test(r.error) && /permission denied/.test(r.error));
  setup([], []); STATE.valid = false; r = await get();
  ok('no valid token: refused (401)', r.status === 401);
  setup([], []); STATE.role = false; r = await get();
  ok('a signed-in user who is not SUPER_ADMIN or OPERATIONS: refused (403)', r.status === 403);
  setup([], []); r = await ep.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer x' } });
  ok('read-only: anything but GET is refused (405)', r.statusCode === 405);
})().catch(e => { console.log('FAIL - threw: ' + e.stack); bad++; process.exitCode = 1; });

process.on('exit', () => { if (!bad) console.log('\nAll platform Flutterwave tests passed.'); });
