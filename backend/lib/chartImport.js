/**
 * zillion/backend/lib/chartImport.js
 *
 * Validates the rows of an Excel / CSV chart of accounts before anything is saved. Pure: no database.
 * Columns (heading names are forgiving): Code, Name, Type, Sub-type (optional), Opening Balance (optional), Side (optional, Debit/Credit).
 * An opening balance with no Side takes the account type's normal side (assets and expenses debit, the rest credit).
 */
'use strict';
const { ACCOUNT_TYPES, SUB_TYPES } = require('./coopAccounting');

const DEBIT_NORMAL = new Set(['ASSET', 'EXPENSE']);
const norm = s => String(s == null ? '' : s).trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const COLS = {
  code: ['code', 'account code', 'acc code', 'a c code', 'account no', 'account number', 'no'],
  name: ['name', 'account name', 'account', 'account title', 'description', 'title'],
  type: ['type', 'account type', 'class', 'category', 'group'],
  sub_type: ['sub type', 'subtype', 'sub group', 'subgroup', 'sub category', 'classification'],
  opening: ['opening balance', 'opening', 'balance', 'opening bal', 'amount'],
  side: ['side', 'dr cr', 'dr or cr', 'balance type', 'debit credit', 'normal balance'],
};
const TYPE_ALIASES = { assets: 'ASSET', asset: 'ASSET', liability: 'LIABILITY', liabilities: 'LIABILITY', equity: 'EQUITY', capital: 'EQUITY', 'net assets': 'EQUITY',
  income: 'INCOME', revenue: 'INCOME', revenues: 'INCOME', sales: 'INCOME', expense: 'EXPENSE', expenses: 'EXPENSE', cost: 'EXPENSE', costs: 'EXPENSE' };

function toKobo(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) : NaN;
  let s = String(v).trim().replace(/^[₦N]\s*/i, '').replace(/,/g, '');
  let neg = false; if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return NaN;
  const n = Math.round(parseFloat(s) * 100);
  return neg ? -n : n;
}

function resolveSubType(type, raw) {
  if (!raw) return { value: null };
  const n = norm(raw);
  const hit = SUB_TYPES[type].find(s => norm(s.key) === n || norm(s.label) === n || norm(s.label).startsWith(n));
  return hit ? { value: hit.key } : { error: `sub-type "${raw}" is not valid for ${type} (use: ${SUB_TYPES[type].map(s => s.label).join(', ')})` };
}

/** @returns {{rows: Array, errors: Array, totals: object}} rows are the valid ones ready to save; errors carry the spreadsheet row number. */
function validateChartRows(grid, existingCodes = new Set()) {
  if (!Array.isArray(grid) || !grid.length) return { rows: [], errors: [{ row: 0, message: 'The file is empty.' }], totals: {} };
  let h = -1, map = null;
  for (let i = 0; i < Math.min(grid.length, 30); i++) {
    const m = {};
    (grid[i] || []).forEach((c, j) => { const n = norm(c); for (const k of Object.keys(COLS)) if (m[k] == null && COLS[k].includes(n)) m[k] = j; });
    if (m.code != null && m.name != null && m.type != null) { h = i; map = m; break; }
  }
  if (h < 0) return { rows: [], errors: [{ row: 0, message: 'Could not find the headings. The first row needs at least: Code, Name and Type.' }], totals: {} };

  const rows = [], errors = [], seen = new Set();
  let debits = 0, credits = 0;
  for (let i = h + 1; i < grid.length; i++) {
    const r = grid[i] || [];
    if (r.every(c => String(c == null ? '' : c).trim() === '')) continue;
    const rowNo = i + 1;
    const code = String(r[map.code] == null ? '' : r[map.code]).trim();
    const name = String(r[map.name] == null ? '' : r[map.name]).trim().replace(/\s+/g, ' ');
    const typeRaw = String(r[map.type] == null ? '' : r[map.type]).trim();
    const fail = m => errors.push({ row: rowNo, code, name, message: m });
    if (!code) { fail('no account code'); continue; }
    if (!/^[A-Za-z0-9._-]{1,20}$/.test(code)) { fail('the account code may only contain letters, numbers, dots, dashes and underscores (max 20)'); continue; }
    if (!name) { fail('no account name'); continue; }
    if (name.length > 120) { fail('the account name is longer than 120 characters'); continue; }
    const type = TYPE_ALIASES[norm(typeRaw)] || (ACCOUNT_TYPES.includes(typeRaw.toUpperCase()) ? typeRaw.toUpperCase() : null);
    if (!type) { fail(`type "${typeRaw}" is not one of Asset, Liability, Equity, Income, Expense`); continue; }
    if (seen.has(code.toLowerCase())) { fail('this code appears twice in the file'); continue; }
    if (existingCodes.has(code.toLowerCase())) { fail('this code already exists in your chart of accounts (it was left unchanged)'); continue; }
    const sub = resolveSubType(type, map.sub_type != null ? String(r[map.sub_type] == null ? '' : r[map.sub_type]).trim() : '');
    if (sub.error) { fail(sub.error); continue; }

    let opening = null, side = null;
    if (map.opening != null) {
      const k = toKobo(r[map.opening]);
      if (Number.isNaN(k)) { fail(`opening balance "${r[map.opening]}" is not a number`); continue; }
      if (k) {
        let sideRaw = map.side != null ? norm(r[map.side]) : '';
        if (sideRaw) {
          if (/^(dr|debit|d)$/.test(sideRaw)) side = 'debit'; else if (/^(cr|credit|c)$/.test(sideRaw)) side = 'credit';
          else { fail(`side "${r[map.side]}" must be Debit or Credit`); continue; }
        } else side = DEBIT_NORMAL.has(type) ? 'debit' : 'credit';
        if (k < 0) side = side === 'debit' ? 'credit' : 'debit';   // a negative figure flips the side
        opening = Math.abs(k);
      }
    }
    seen.add(code.toLowerCase());
    if (opening) { if (side === 'debit') debits += opening; else credits += opening; }
    rows.push({ row: rowNo, account_code: code, account_name: name, account_type: type, sub_type: sub.value, opening_kobo: opening, side });
  }
  return { rows, errors, totals: { accounts: rows.length, with_opening: rows.filter(r => r.opening_kobo).length, debits_kobo: debits, credits_kobo: credits, difference_kobo: debits - credits } };
}

module.exports = { validateChartRows, toKobo };
