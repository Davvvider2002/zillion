/**
 * zillion/backend/tests/test-late-fee-config.js
 *
 * Saving "no late fee" for dues and "no loan penalty" failed in production with database constraint errors, and
 * nothing caught it because the usual fake database does not enforce NOT NULL / CHECK constraints. This runs the
 * REAL configure handlers against a database that does:
 *   - the OLD schema, to prove the harness reproduces the two reported errors exactly, and
 *   - the NEW schema (what production now has), to prove they are fixed and the real-fee cases still work.
 * Run: node backend/tests/test-late-fee-config.js
 */
'use strict';
const path = require('path');
const LIB = path.join(__dirname, '..', 'lib');
const FN = path.join(__dirname, '..', 'netlify', 'functions');
const { makeDb } = require('./helpers/fakeDb');

let currentDb = null;
const stub = (mod, exports) => { require.cache[require.resolve(path.join(LIB, mod))] = { id: mod, filename: mod, loaded: true, exports }; };
stub('supabase', { getServiceClient: () => currentDb });
stub('validators', { verifyJWT: () => ({ valid: true, payload: { merchant_id: 'M1', role: 'merchant' } }) });
stub('coopPortalAuth', { resolvePortalSociety: async () => ({ ok: true, society: { coop_id: 'C1' } }), requirePortalPermission: async () => true });
stub('auditLog', { auditLog: async () => {} });
const dues = require(path.join(FN, 'coop-portal-configure-dues')).handler;
const penalty = require(path.join(FN, 'coop-portal-configure-loan-penalty')).handler;

// The coop_societies rules, as the database enforces them. Message wording mirrors Postgres so the reproduction
// is recognisable against what was actually reported.
const OLD_SCHEMA = { notNull: ['late_fee_type', 'late_fee_value'], checks: { loan_late_fee_type: { name: 'coop_societies_loan_late_fee_type_check', allowed: [null, 'flat', 'percentage'] } } };
const NEW_SCHEMA = { notNull: ['late_fee_value'], checks: {
  late_fee_type: { name: 'coop_societies_late_fee_type_check', allowed: [null, 'flat', 'percentage'] },
  loan_late_fee_type: { name: 'coop_societies_loan_late_fee_type_check', allowed: [null, 'none', 'flat', 'percentage'] } } };

function enforce(db, schema) {
  const from = db.from.bind(db);
  db.from = (t) => {
    const q = from(t);
    if (t !== 'coop_societies') return q;
    const update = q.update.bind(q);
    q.update = (patch) => {
      for (const col of schema.notNull) if (col in patch && (patch[col] === null || patch[col] === undefined))
        return rejected(`null value in column "${col}" of relation "coop_societies" violates not-null constraint`);
      for (const [col, c] of Object.entries(schema.checks)) if (col in patch && !c.allowed.includes(patch[col]))
        return rejected(`new row for relation "coop_societies" violates check constraint "${c.name}"`);
      return update(patch);
    };
    return q;
  };
  return db;
}
function rejected(message) { const q = { select() { return q; }, eq() { return q; }, single() { return q; }, maybeSingle() { return q; }, then(res) { return res({ data: null, error: { message } }); } }; return q; }

const freshDb = schema => enforce(makeDb({ coop_societies: [{ coop_id: 'C1', late_fee_type: 'flat', late_fee_value: 50000, loan_late_fee_type: null, loan_late_fee_value: null }] }), schema);
const call = (h, body) => h({ httpMethod: 'POST', headers: { authorization: 'Bearer x' }, body: JSON.stringify(body) });
const duesBody = extra => ({ dues_amount_kobo: 500000, dues_frequency: 'monthly', dues_enforcement_enabled: false, ...extra });

let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };

(async () => {
  // ── the harness reproduces the two reported errors on the OLD schema ─────────────────────
  currentDb = freshDb(OLD_SCHEMA);
  let r = await call(dues, duesBody({}));
  ok('OLD schema: saving dues with no late fee fails exactly as reported (late_fee_type not-null)',
    r.statusCode === 500 && /Failed to configure dues: null value in column "late_fee_type" of relation "coop_societies" violates not-null constraint/.test(JSON.parse(r.body).error));
  currentDb = freshDb(OLD_SCHEMA);
  r = await call(penalty, { loan_late_fee_type: 'none' });
  ok("OLD schema: saving loan penalty 'none' fails exactly as reported (check constraint)",
    r.statusCode === 500 && /Failed to configure loan penalty: new row for relation "coop_societies" violates check constraint "coop_societies_loan_late_fee_type_check"/.test(JSON.parse(r.body).error));

  // ── the NEW schema (production now) ───────────────────────────────────────────────────
  currentDb = freshDb(NEW_SCHEMA);
  r = await call(dues, duesBody({}));
  let row = currentDb.tables.coop_societies[0];
  ok('NEW schema: dues with no late fee saves', r.statusCode === 200);
  ok('...stored as NULL type and a value of 0 (never null - that column is NOT NULL)', row.late_fee_type === null && row.late_fee_value === 0);

  currentDb = freshDb(NEW_SCHEMA);
  r = await call(dues, duesBody({ late_fee_type: 'flat', late_fee_value: 50000 }));
  row = currentDb.tables.coop_societies[0];
  ok('NEW schema: a flat dues late fee still saves and is stored as given', r.statusCode === 200 && row.late_fee_type === 'flat' && row.late_fee_value === 50000);
  currentDb = freshDb(NEW_SCHEMA);
  r = await call(dues, duesBody({ late_fee_type: 'percentage', late_fee_value: 500 }));
  ok('NEW schema: a percentage dues late fee still saves', r.statusCode === 200 && currentDb.tables.coop_societies[0].late_fee_type === 'percentage');
  currentDb = freshDb(NEW_SCHEMA);
  r = await call(dues, duesBody({ late_fee_type: 'weekly', late_fee_value: 5 }));
  ok('an unrecognised dues late-fee type is still refused up front (400, before reaching the database)', r.statusCode === 400);
  currentDb = freshDb(NEW_SCHEMA);
  r = await call(dues, duesBody({ late_fee_type: 'flat' }));
  ok('a late-fee type without a value is still refused (400)', r.statusCode === 400);

  for (const [label, body, expect] of [
    ["'none' (explicit opt-out)", { loan_late_fee_type: 'none' }, { t: 'none', v: null }],
    ['null (inherit from dues)', { loan_late_fee_type: null }, { t: null, v: null }],
    ['a separate flat rate', { loan_late_fee_type: 'flat', loan_late_fee_value: 100000 }, { t: 'flat', v: 100000 }],
    ['a separate percentage rate', { loan_late_fee_type: 'percentage', loan_late_fee_value: 500 }, { t: 'percentage', v: 500 }]]) {
    currentDb = freshDb(NEW_SCHEMA);
    r = await call(penalty, body); row = currentDb.tables.coop_societies[0];
    ok(`NEW schema: loan penalty ${label} saves as intended`, r.statusCode === 200 && row.loan_late_fee_type === expect.t && row.loan_late_fee_value === expect.v);
  }
  currentDb = freshDb(NEW_SCHEMA);
  r = await call(penalty, { loan_late_fee_type: 'bogus' });
  ok('an unrecognised loan penalty type is still refused (400)', r.statusCode === 400);
})().catch(e => { console.log('FAIL - scenario threw: ' + e.message + '\n' + e.stack); bad++; process.exitCode = 1; });

process.on('exit', () => { if (!bad) console.log('\nAll late fee configuration tests passed.'); });
