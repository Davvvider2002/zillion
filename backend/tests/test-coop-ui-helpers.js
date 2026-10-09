/**
 * zillion/backend/tests/test-coop-ui-helpers.js
 * The Coop portal's investment summary sentence and add-on icons. Pulls the real functions out of coop-admin/index.html.
 * Run: node backend/tests/test-coop-ui-helpers.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'coop-admin', 'index.html'), 'utf8');
let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };
const grab = n => { const i = html.indexOf('function ' + n); let d = 0; for (let k = html.indexOf('{', i); k < html.length; k++) { if (html[k] === '{') d++; if (html[k] === '}' && !--d) return html.slice(i, k + 1); } };
const icons = html.match(/const ADDON_ICONS = \{[^}]*\};/)[0];
const { fmtNaira, investmentSummaryLine, addonIcon } = new Function(icons + ['fmtNaira', 'investmentSummaryLine', 'addonIcon'].map(grab).join('\n') + '; return { fmtNaira, investmentSummaryLine, addonIcon };')();

const pooled = { product_type: 'general', total_units: 500, units_sold: 320, unit_price_kobo: 1000000, tenure_months: 12, return_type: 'fixed', fixed_return_rate_percent: 12, early_withdrawal_penalty_percent: 5 };
const s1 = investmentSummaryLine(pooled);
ok('pooled fixed product: states the pool, price, rate, tenure and the payout per unit', /500 units at ₦10,000/.test(s1) && /fixed 12% over 12 months/.test(s1) && /₦11,200 per unit/.test(s1));
ok('early withdrawal penalty and units taken are mentioned', /costs 5%/.test(s1) && /320 of 500 units taken/.test(s1));
const s2 = investmentSummaryLine({ product_type: 'individual', unit_price_kobo: 500000, tenure_months: 1, return_type: 'variable' });
ok('individual variable product: says returns follow performance and can be a loss, singular month', /own, ₦5,000 per unit/.test(s2) && /can be a loss/.test(s2) && /1 month\b/.test(s2) && !/months/.test(s2));
ok('no penalty sentence when the penalty is zero', !/Early withdrawal/.test(s2));
ok('every known add-on key has its own icon', ['accounting', 'bank_reconciliation', 'surplus_dividends', 'investment', 'payroll'].every(k => addonIcon(k, k) !== '🧩'));
ok('an unknown add-on is matched by name, else gets the neutral default', addonIcon('zz', 'SMS alerts') === '💬' && addonIcon('zz', 'Something new') === '🧩');

// ── the public landing page (zillion.ng/coop) and the portal share the same add-on rules ───────────────────────────────
const landing = fs.readFileSync(path.join(__dirname, '..', '..', 'coop', 'index.html'), 'utf8');
const grabFrom = (src, n) => { const i = src.indexOf('function ' + n); let d = 0; for (let k = src.indexOf('{', i); k < src.length; k++) { if (src[k] === '{') d++; if (src[k] === '}' && !--d) return src.slice(i, k + 1); } };
const consts = src => src.match(/const ADDON_FALLBACK_DESCRIPTIONS = \{[\s\S]*?\n\};/)[0] + '\n' + src.match(/const ADDON_ICONS = \{[^}]*\};/)[0];
const L = new Function(consts(landing) + ['escHtml', 'addonIcon', 'addonDescription'].map(n => grabFrom(landing, n)).join('\n') + '; return { escHtml, addonIcon, addonDescription };')();
const P = new Function(consts(html) + ['addonIcon', 'addonDescription'].map(n => grabFrom(html, n)).join('\n') + '; return { addonIcon, addonDescription };')();
ok('landing page: Investment gets a description when the database has none', L.addonDescription('investment', null).length > 40 && L.addonDescription('investment', '   ').length > 40);
ok('landing page: a description from the database is kept, not overwritten', L.addonDescription('investment', 'Custom words') === 'Custom words');
ok('landing page: every known module has an icon and a fallback description', ['accounting', 'bank_reconciliation', 'investment', 'payroll', 'surplus_dividends'].every(k => L.addonIcon(k, k) !== '🧩' && L.addonDescription(k, '').length > 20));
ok("landing page: the 'Surplus & Member Benefits' name still gets the dividends icon, whatever its key", L.addonIcon('x', 'Surplus & Member Benefits') === '💰');
ok('landing page and portal agree on every icon and fallback description', ['accounting', 'bank_reconciliation', 'investment', 'payroll', 'surplus_dividends', 'other'].every(k => L.addonIcon(k, k) === P.addonIcon(k, k) && L.addonDescription(k, '') === P.addonDescription(k, '')));
ok('landing page: module names and descriptions are escaped, and the card shows the icon', /escHtml\(a\.name\)/.test(landing) && (landing.match(/escHtml\(addonDescription\(a\.key, a\.description\)\)/g) || []).length === 2 && /addonIcon\(a\.key, a\.name\)/.test(landing) && !/\$\{a\.name\}/.test(landing));
console.log(bad ? `\n${bad} FAILED` : '\nAll UI helper checks passed.');
