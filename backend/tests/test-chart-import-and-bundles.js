/**
 * zillion/backend/tests/test-chart-import-and-bundles.js
 * Chart-of-accounts import validation, and the Micro / Starter bundles: pricing, yearly-only, included modules, member caps,
 * single-use admin-issued links, and the sign-up gate (public cannot pick a bundle; a link can be used once; a failed sign-up releases it).
 * Run: node backend/tests/test-chart-import-and-bundles.js
 */
'use strict';
const path = require('path');
const LIB = path.join(__dirname, '..', 'lib'); const FN = path.join(__dirname, '..', 'netlify', 'functions');
const { makeDb } = require('./helpers/fakeDb');
process.env.JWT_SECRET = 'test-secret';
let currentDb = null;
const stub = (mod, exports) => { require.cache[require.resolve(path.join(LIB, mod))] = { id: mod, filename: mod, loaded: true, exports }; };
stub('supabase', { getServiceClient: () => currentDb });
stub('zillionId', { resolveOrCreateZillionId: async () => 'ZIL-TEST' });
stub('coopTermsAcceptance', { recordTermsAcceptance: async () => {}, getClientIp: () => null, CURRENT_TERMS_VERSION: 'v1', CURRENT_PRIVACY_VERSION: 'v1' });
const { validateChartRows } = require(path.join(LIB, 'chartImport'));
const B = require(path.join(LIB, 'coopBundles'));
const { computeSubscriptionTotal } = require(path.join(LIB, 'coopPricing'));
const signup = require(path.join(FN, 'public-coop-signup')).handler;
let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };

// ── chart import
const H = ['Code', 'Name', 'Type', 'Sub-type', 'Opening Balance', 'Side'];
const v = validateChartRows([H, ['1015', 'GTB', 'Asset', 'Bank & Cash', 250000, 'Debit'], ['2200', 'Fund', 'Liability', '', '50,000.50', 'Credit'], ['4300', 'Hall', 'Income'], ['1000', 'Cash dup', 'Asset'], ['9', 'Bad', 'Nonsense'], ['4300', 'Twice', 'Income'], ['5300', 'Fuel', 'Expense', 'Bank & Cash']], new Set(['1000']));
ok('chart: valid rows accepted', v.rows.length === 3 && v.rows[0].sub_type === 'bank_cash' && v.rows[0].opening_kobo === 25000000 && v.rows[0].side === 'debit');
ok('chart: opening with no side takes the account type normal side', validateChartRows([H.slice(0, 5), ['1', 'A', 'Asset', '', 100], ['2', 'L', 'Liability', '', 100]]).rows.map(r => r.side).join() === 'debit,credit');
ok('chart: existing code never overwritten', v.errors.some(e => e.code === '1000' && /already exists/.test(e.message)));
ok('chart: unknown type reported with its row number', v.errors.some(e => e.row === 6 && /Nonsense/.test(e.message)));
ok('chart: duplicate code inside the file reported', v.errors.some(e => e.code === '4300' && /twice/.test(e.message)));
ok('chart: sub-type from another type reported', v.errors.some(e => e.code === '5300'));
ok('chart: no headings refused', validateChartRows([['a', 'b'], ['1', '2']]).errors[0].row === 0);
ok('chart: totals show debits, credits and the difference', v.totals.debits_kobo === 25000000 && v.totals.credits_kobo === 5000050 && v.totals.difference_kobo === 19999950);
ok('chart: markup in a name is kept as text (escaped on display), not rejected', validateChartRows([H.slice(0, 3), ['7', '<b>x</b>', 'Asset']]).rows.length === 1);

// ── bundles: pricing
const mkCatalog = () => [
  { tier: 'launch', cycle: 'yearly', amount_kobo: 10098000, member_cap: 100 }, { tier: 'launch', cycle: 'monthly', amount_kobo: 990000, member_cap: 100 },
  { tier: 'micro_bundle', cycle: 'yearly', amount_kobo: 10000000, member_cap: 50 }, { tier: 'starter_bundle', cycle: 'yearly', amount_kobo: 18000000, member_cap: 100 }];
const mods = [{ key: 'accounting', name: 'Accounting & Finance', price_kobo: 500000, active: true }, { key: 'bank_reconciliation', name: 'Bank Reconciliation', price_kobo: 300000, active: true }, { key: 'surplus_dividends', name: 'Shares & Dividends', price_kobo: 300000, active: true }, { key: 'payroll', name: 'Payroll', price_kobo: 400000, active: true }];
(async () => {
  const db0 = makeDb({ coop_subscription_plan_catalog: mkCatalog(), coop_addon_modules: mods });
  const micro = await computeSubscriptionTotal(db0, { tier: 'micro_bundle', cycle: 'yearly', addonKeys: B.addonKeysFor('micro_bundle', []) });
  ok('pricing: Micro is exactly N100,000/year with its three modules included', micro.ok && micro.totalKobo === 10000000 && micro.addons.length === 3 && micro.addons.every(a => a.priceKobo === 0));
  const starter = await computeSubscriptionTotal(db0, { tier: 'starter_bundle', cycle: 'yearly', addonKeys: B.addonKeysFor('starter_bundle', []) });
  ok('pricing: Starter is exactly N180,000/year', starter.ok && starter.totalKobo === 18000000);
  const plusPayroll = await computeSubscriptionTotal(db0, { tier: 'micro_bundle', cycle: 'yearly', addonKeys: B.addonKeysFor('micro_bundle', ['payroll']) });
  ok('pricing: an extra module on top of a bundle is still charged, the included ones are not', plusPayroll.totalKobo === 10000000 + Math.round(400000 * 12 * 0.85));
  ok('pricing: no monthly bundle', (await computeSubscriptionTotal(db0, { tier: 'micro_bundle', cycle: 'monthly', addonKeys: [] })).ok === false);
  const normal = await computeSubscriptionTotal(db0, { tier: 'launch', cycle: 'yearly', addonKeys: ['accounting'] });
  ok('pricing: ordinary plans unchanged (add-on still charged)', normal.totalKobo === 10098000 + Math.round(500000 * 12 * 0.85));
  ok('bundle: member caps 50 and 100 in the plan rows', B.BUNDLE_TIERS.micro_bundle.memberCap === 50 && B.BUNDLE_TIERS.starter_bundle.memberCap === 100);

  // ── links and the sign-up gate
  const body = (extra) => ({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ society_name: 'Alpha Women Thrift', phone: '08031234567', owner_name: 'Ada', email: 'a@b.co', password: 'secret1', terms_accepted: true, ...extra }) });
  const fresh = () => makeDb({ merchants: [], coop_societies: [], coop_society_addons: [], coop_referral_attributions: [], coop_agents: [{ id: 'AG1', referral_code: 'ADA1', status: 'ACTIVE' }], rate_limit_attempts: [], coop_subscription_plan_catalog: mkCatalog(), coop_addon_modules: mods, coop_bundle_links: [], zillion_identities: [], devices: [], alerts: [] },
    { defaults: { coop_societies: () => ({ coop_id: 'COOPSOC-' + Math.random().toString(16).slice(2, 10).toUpperCase(), trial_ends_at: new Date().toISOString() }) } });
  const addLink = (db, o = {}) => { const code = B.newLinkCode(); db.tables.coop_bundle_links.push({ id: 'L' + (db.tables.coop_bundle_links.length + 1), code, tier: 'micro_bundle', agent_id: null, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 864e5).toISOString(), used_at: null, revoked_at: null, ...o }); return code; };
  currentDb = fresh();
  ok('link codes are long and unguessable', B.newLinkCode().length >= 30 && B.newLinkCode() !== B.newLinkCode());

  let res = await signup(body({ plan: 'micro_bundle', cycle: 'yearly' }));
  ok('gate: the public cannot choose a bundle on the form', res.statusCode === 400 && currentDb.tables.coop_societies.length === 0);
  res = await signup(body({ bundle_code: 'x'.repeat(30) }));
  ok('gate: an unknown link is refused', res.statusCode === 400 && currentDb.tables.coop_societies.length === 0);

  const code = addLink(currentDb, { agent_id: 'AG1' });
  res = await signup(body({ bundle_code: code, plan: 'scale', cycle: 'monthly', addon_keys: ['payroll'] }));
  const out = JSON.parse(res.body);
  const soc = currentDb.tables.coop_societies[0];
  ok('signup via link succeeds', res.statusCode === 200 && !!soc);
  ok('link decides the plan: bundle, yearly, whatever the form said', soc && soc.subscription_plan === 'micro_bundle' && soc.subscription_cycle === 'yearly' && soc.signup_source === 'bundle_link');
  ok('total is the bundle price, form add-on ignored', out.total_kobo === 10000000);
  ok('the three included modules are switched on, and only those', currentDb.tables.coop_society_addons.map(a => a.addon_key).sort().join() === 'accounting,bank_reconciliation,surplus_dividends');
  ok('link is marked used by that society', currentDb.tables.coop_bundle_links[0].used_at && currentDb.tables.coop_bundle_links[0].used_by_coop_id === soc.coop_id);
  ok('agent who asked for it gets the referral', currentDb.tables.coop_referral_attributions.length === 1 && currentDb.tables.coop_referral_attributions[0].agent_id === 'AG1');
  res = await signup({ ...body({ bundle_code: code, society_name: 'Beta Traders Union', phone: '08039999999' }) });
  ok('a used link cannot sign up a second society', res.statusCode === 400 && /already been used/.test(JSON.parse(res.body).error) && currentDb.tables.coop_societies.length === 1);

  currentDb = fresh();
  const expired = addLink(currentDb, { expires_at: new Date(Date.now() - 1000).toISOString() });
  res = await signup(body({ bundle_code: expired }));
  ok('an expired link is refused', res.statusCode === 400 && /expired/.test(JSON.parse(res.body).error));
  const revoked = addLink(currentDb, { revoked_at: new Date().toISOString() });
  res = await signup(body({ bundle_code: revoked }));
  ok('a cancelled link is refused', res.statusCode === 400 && /cancelled/.test(JSON.parse(res.body).error));

  currentDb = fresh();
  const c2 = addLink(currentDb, { tier: 'starter_bundle' });
  currentDb.failNextInsertOn = 'coop_societies';
  res = await signup(body({ bundle_code: c2 }));
  ok('if sign-up fails, the link is released and can be used again', res.statusCode >= 400 && currentDb.tables.coop_bundle_links[0].used_at == null);
  res = await signup(body({ bundle_code: c2 }));
  ok('...and the retry works, as Starter at N180,000', res.statusCode === 200 && JSON.parse(res.body).total_kobo === 18000000 && currentDb.tables.coop_societies[0].subscription_plan === 'starter_bundle');

  // two people racing on one link: the claim itself must let only one through
  currentDb = fresh();
  addLink(currentDb);
  const first = await B.claimLink(currentDb, 'L1', 'COOP-A'); const second = await B.claimLink(currentDb, 'L1', 'COOP-B');
  ok('claim is atomic: the second claimant on the same link loses', first === true && second === false && currentDb.tables.coop_bundle_links[0].used_by_coop_id === 'COOP-A');

  // an ordinary sign-up is unaffected
  currentDb = fresh();
  res = await signup(body({ plan: 'launch', cycle: 'yearly' }));
  ok('ordinary plans still sign up normally', res.statusCode === 200 && currentDb.tables.coop_societies[0].subscription_plan === 'launch' && currentDb.tables.coop_society_addons.length === 0);

  console.log(bad ? `\n${bad} FAILED` : '\nAll chart import and bundle checks passed');
})();
