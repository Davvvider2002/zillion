/**
 * zillion/backend/lib/coopGoLiveImport.js
 *
 * Go-live catch-up, phase 2: the importers. A society that starts on Zillion part way through its financial year
 * uploads what already happened, one sheet per kind of record. Every sheet is checked first (dry run, row by row)
 * and only then applied into a draft migration batch (see coopGoLiveBatch.js). Applying writes into the SAME tables
 * live operation uses, with the real dates, so statements, reports and the dividend run need no special cases.
 *
 * Sheets, in the order they must be loaded: members, shares, savings, dues, loans, loan_repayments.
 * Money in a sheet is in naira (as people write it); everything stored is integer kobo.
 *
 * Journals: when the society's accounting is ready, each imported row is also booked as a dated journal entry using
 * the same accounts live entry uses, tagged with the batch and the sheet that made it. Rows dated before the financial
 * year start are refused for the ledgers (they belong in the opening balances), apart from loans themselves and the
 * "repaid before the year" figure, which carry no journal because the opening balances already hold them.
 */
'use strict';

const { cleanText } = require('./cleanText');
const { fetchAllRows, chunk } = require('./coopPaginate');
const { isRealDay, NOON_WAT } = require('./coopGoLiveBatch');
const { normalisePhone, activateMember } = require('./coopActivateMember');
const { computeRepaymentSplit } = require('./coopLoanAccounting');
const { computeReducingBalanceSplit } = require('./coopReducingBalanceSplit');
const { generateRepaymentSchedule } = require('./coopRepaymentSchedule');
const { generateEmiSchedule, generateDecliningPrincipalSchedule } = require('./coopReducingBalanceSchedule');
const { accountingIsReady, getAccounts, nextEntryNumber } = require('./coopAccountingHelpers');
const { checkMemberCapAllows } = require('./coopMemberCap');

const ORDER = ['members', 'shares', 'savings', 'dues', 'loans', 'loan_repayments'];
const MAX_ROWS = { members: 200, shares: 500, savings: 500, dues: 500, loans: 300, loan_repayments: 500 };

const CASH = '1000', BANK = '1010', SAVINGS_PAYABLE = '2000', SHARE_CAPITAL = '3000', DUES_RECEIVABLE = '1150';
const LOAN_PRINCIPAL = '1100', LOAN_INTEREST = '1110', INTEREST_INCOME = '4150';

const DATASETS = {
  members: {
    title: 'Members',
    columns: [
      { name: 'member_no', required: false, help: 'The society\'s own member number. Leave blank to have Zillion number them.', aliases: ['member_number', 'memberno', 'no'] },
      { name: 'name', required: true, help: 'Full name.', aliases: ['full_name', 'member_name'] },
      { name: 'phone', required: true, help: 'Mobile number. Needed to activate the member\'s wallet.', aliases: ['phone_number', 'mobile', 'mobile_number', 'tel', 'telephone'] },
      { name: 'join_date', required: true, help: 'Day the member joined, YYYY-MM-DD or DD/MM/YYYY. Dues and years of membership run from this day.', aliases: ['joined', 'date_joined', 'joined_on'] },
      { name: 'status', required: false, help: 'active (default) or exited.', aliases: [] },
      { name: 'exit_date', required: false, help: 'Required when status is exited. The day the member left.', aliases: ['exited_on', 'date_exited'] },
      { name: 'exit_reason', required: false, help: 'Optional note.', aliases: [] },
      { name: 'postcode', required: false, help: 'Optional NIPOST digital postcode.', aliases: ['digital_postcode'] },
    ],
    examples: [
      ['0001', 'Adaobi Okafor', '08031234567', '2019-05-10', 'active', '', '', ''],
      ['0002', 'Tunde Bakare', '08051234567', '2021-02-01', 'exited', '2026-04-30', 'Relocated', ''],
    ],
  },
  shares: {
    title: 'Shares',
    columns: [
      { name: 'member_no', required: true, help: 'Member number, or the member\'s phone number.', aliases: ['member', 'phone'] },
      { name: 'date', required: true, help: 'Day of the transaction, inside the financial year.', aliases: ['transaction_date'] },
      { name: 'type', required: false, help: 'purchase (default) or withdrawal.', aliases: [] },
      { name: 'amount', required: true, help: 'Naira, positive.', aliases: [] },
      { name: 'method', required: false, help: 'cash or bank (default bank).', aliases: ['source'] },
      { name: 'reference', required: false, help: 'Receipt or transfer reference.', aliases: ['ref'] },
    ],
    examples: [['0001', '2026-02-14', 'purchase', '50000', 'bank', 'TRF-0214'], ['0001', '2026-06-30', 'purchase', '25000', 'cash', 'RCPT-118']],
  },
  savings: {
    title: 'Savings deposits',
    columns: [
      { name: 'member_no', required: true, help: 'Member number, or the member\'s phone number.', aliases: ['member', 'phone'] },
      { name: 'date', required: true, help: 'Day of the deposit, inside the financial year.', aliases: ['transaction_date'] },
      { name: 'amount', required: true, help: 'Naira, positive. Deposits only: withdrawals cannot be imported.', aliases: [] },
      { name: 'method', required: false, help: 'cash or bank (default bank).', aliases: ['source'] },
      { name: 'reference', required: false, help: 'Receipt or transfer reference.', aliases: ['ref'] },
    ],
    examples: [['0001', '2026-01-31', '20000', 'bank', 'TRF-0131'], ['0001', '2026-02-28', '20000', 'bank', 'TRF-0228']],
  },
  dues: {
    title: 'Dues paid',
    columns: [
      { name: 'member_no', required: true, help: 'Member number, or the member\'s phone number.', aliases: ['member', 'phone'] },
      { name: 'date', required: true, help: 'Day the dues were paid, inside the financial year.', aliases: ['transaction_date'] },
      { name: 'amount', required: true, help: 'Naira, positive.', aliases: [] },
      { name: 'method', required: false, help: 'cash or bank (default bank).', aliases: ['source'] },
      { name: 'reference', required: false, help: 'Receipt or transfer reference.', aliases: ['ref'] },
    ],
    examples: [['0001', '2026-01-15', '5000', 'cash', 'RCPT-004'], ['0001', '2026-04-15', '5000', 'cash', 'RCPT-061']],
  },
  loans: {
    title: 'Loans',
    columns: [
      { name: 'loan_ref', required: true, help: 'Your own loan reference. Repayments find their loan by this.', aliases: ['ref', 'loan_no', 'loan_number'] },
      { name: 'member_no', required: true, help: 'Borrower\'s member number, or phone number.', aliases: ['member', 'phone'] },
      { name: 'principal', required: true, help: 'Amount lent, naira.', aliases: ['amount'] },
      { name: 'interest_method', required: false, help: 'flat (default), reducing_emi or reducing_declining.', aliases: ['method'] },
      { name: 'interest_rate_percent', required: false, help: 'Flat: percent of principal for the whole loan. Reducing: percent per month. Blank means no interest.', aliases: ['rate', 'interest_rate'] },
      { name: 'term_months', required: true, help: 'Number of monthly repayments.', aliases: ['months', 'term'] },
      { name: 'disbursed_date', required: true, help: 'Day the money was lent. May be before the financial year start.', aliases: ['date', 'disbursed_on'] },
      { name: 'repaid_before_year', required: false, help: 'Naira repaid before the financial year start. Only for loans lent before it.', aliases: ['repaid_before_fy', 'opening_repaid'] },
    ],
    examples: [['L-2025-014', '0001', '300000', 'flat', '10', '12', '2025-11-01', '50000'], ['L-2026-003', '0002', '100000', 'reducing_emi', '2', '6', '2026-03-10', '']],
  },
  loan_repayments: {
    title: 'Loan repayments',
    columns: [
      { name: 'loan_ref', required: true, help: 'The loan_ref from the loans sheet.', aliases: ['ref', 'loan_no', 'loan_number'] },
      { name: 'date', required: true, help: 'Day of the repayment, inside the financial year.', aliases: ['transaction_date'] },
      { name: 'amount', required: true, help: 'Total naira paid.', aliases: [] },
      { name: 'principal_part', required: false, help: 'Optional. If you give one part you must give both, adding up to the amount. Blank lets Zillion split it.', aliases: ['principal'] },
      { name: 'interest_part', required: false, help: 'Optional, see principal_part.', aliases: ['interest'] },
      { name: 'method', required: false, help: 'cash or bank (default bank).', aliases: ['source'] },
      { name: 'reference', required: false, help: 'Receipt or transfer reference.', aliases: ['ref_no'] },
    ],
    examples: [['L-2025-014', '2026-01-31', '27500', '25000', '2500', 'bank', 'TRF-0131'], ['L-2026-003', '2026-04-10', '17500', '', '', 'cash', 'RCPT-077']],
  },
};

// ───────────────────────────── reading a sheet ─────────────────────────────

/** Splits one line on a delimiter, honouring "quoted, cells". */
function splitLine(line, delim) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(c => c.trim());
}

const normHeader = h => String(h || '').trim().toLowerCase().replace(/[\s\-]+/g, '_');

/** @returns {{rows: Array<{line:number, cells:object}>, error?: string}} */
function parseSheet(dataset, text) {
  const spec = DATASETS[dataset];
  if (!spec) return { rows: [], error: `Unknown sheet "${dataset}".` };
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
  const firstIdx = lines.findIndex(l => l.trim().length);
  if (firstIdx === -1) return { rows: [], error: 'The sheet is empty.' };
  const head = lines[firstIdx];
  const delim = [',', '\t', ';'].map(d => ({ d, n: head.split(d).length })).sort((a, b) => b.n - a.n)[0].d;
  const headers = splitLine(head, delim).map(normHeader);

  const colIndex = {};
  for (const c of spec.columns) {
    const idx = headers.findIndex(h => h === c.name || c.aliases.includes(h));
    if (idx !== -1) colIndex[c.name] = idx;
  }
  const missing = spec.columns.filter(c => c.required && colIndex[c.name] == null).map(c => c.name);
  if (missing.length) {
    return { rows: [], error: `The ${spec.title} sheet needs a column called ${missing.map(m => `"${m}"`).join(', ')}. Found: ${headers.filter(Boolean).map(h => `"${h}"`).join(', ') || 'none'}.` };
  }
  const rows = [];
  for (let i = firstIdx + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const raw = splitLine(lines[i], delim);
    if (raw.every(c => !c)) continue;
    const cells = {};
    for (const c of spec.columns) cells[c.name] = colIndex[c.name] != null ? (raw[colIndex[c.name]] || '').trim() : '';
    rows.push({ line: i + 1, cells });
  }
  return { rows };
}

// ───────────────────────────── cell helpers ─────────────────────────────

/** Accepts YYYY-MM-DD, D/M/YYYY, D-M-YYYY (day first, as in Nigeria). Returns YYYY-MM-DD or null. */
function parseFlexDay(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return isRealDay(s) ? s : null;
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (!m) return null;
  const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return isRealDay(iso) ? iso : null;
}
const stamp = day => day + NOON_WAT;

/** Naira text to kobo. Allows commas, a leading ₦ or N, up to 2 decimals. Returns null if not a plain positive-or-zero amount. */
function parseNaira(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/[₦,\s]/g, '').replace(/^N(?=\d)/i, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100);
}
const fmtNaira = k => '₦' + (k / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function sourceFromMethod(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return { source: 'bank_transfer_manual' };
  if (['cash', 'cash_in_person'].includes(s)) return { source: 'cash_in_person' };
  if (['bank', 'transfer', 'bank_transfer', 'bank_transfer_manual', 'pos', 'cheque'].includes(s)) return { source: 'bank_transfer_manual' };
  return { error: `method "${raw}" must be cash or bank` };
}

function memberKeys(m) {
  const keys = [];
  if (m.member_number) {
    const n = String(m.member_number).trim().toLowerCase();
    keys.push(n);
    if (/^\d+$/.test(n)) keys.push(String(parseInt(n, 10)));
  }
  if (m.phone_normalized) keys.push(m.phone_normalized);
  return keys;
}
function resolveMember(ctx, raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (ctx.members.has(lower)) return ctx.members.get(lower);
  if (/^\d+$/.test(lower) && ctx.members.has(String(parseInt(lower, 10)))) return ctx.members.get(String(parseInt(lower, 10)));
  if (/^[+\d][\d\s+()-]{6,}$/.test(s)) { const p = normalisePhone(s); if (ctx.members.has(p)) return ctx.members.get(p); }
  return null;
}

// ───────────────────────────── validation (pure) ─────────────────────────────

function inWindow(ctx, day) {
  const { fy_start: a, cutover_date: b } = ctx.batch;
  return day >= a && day <= b;
}
function windowMsg(ctx) { return `must fall between the financial year start (${ctx.batch.fy_start}) and the cutover date (${ctx.batch.cutover_date})`; }

function validateMembers(rows, ctx) {
  const valid = [], errors = [], warnings = [];
  const seenPhone = new Set(), seenNo = new Set();
  for (const { line, cells: c } of rows) {
    const fail = msg => errors.push({ line, error: msg });
    const name = cleanText(c.name, 100);
    if (!name) { fail('name is required.'); continue; }
    if (!c.phone) { fail('phone is required.'); continue; }
    const phone = normalisePhone(c.phone);
    if (!/^\+\d{10,15}$/.test(phone)) { fail(`Invalid phone number: "${c.phone}".`); continue; }
    if (seenPhone.has(phone)) { fail(`Phone ${c.phone} appears twice in this sheet.`); continue; }
    const joined = parseFlexDay(c.join_date);
    if (!joined) { fail('join_date must be a real date, YYYY-MM-DD or DD/MM/YYYY.'); continue; }
    if (joined > ctx.batch.cutover_date) { fail(`join_date cannot be after the cutover date (${ctx.batch.cutover_date}).`); continue; }
    const st = String(c.status || 'active').trim().toLowerCase();
    if (!['active', 'exited'].includes(st)) { fail('status must be active or exited.'); continue; }
    let exited = null;
    if (st === 'exited') {
      exited = parseFlexDay(c.exit_date);
      if (!exited) { fail('exit_date is required, as a real date, when status is exited.'); continue; }
      if (exited < joined) { fail('exit_date cannot be before join_date.'); continue; }
      if (exited > ctx.batch.cutover_date) { fail(`exit_date cannot be after the cutover date (${ctx.batch.cutover_date}).`); continue; }
      if (exited < ctx.batch.fy_start) warnings.push({ line, warning: 'This member left before the financial year began, so they will not earn a dividend this year.' });
    }
    const no = cleanText(c.member_no, 20);
    if (no) {
      const k = no.toLowerCase();
      if (seenNo.has(k)) { fail(`member_no ${no} appears twice in this sheet.`); continue; }
      if (ctx.members.has(k) || (/^\d+$/.test(k) && ctx.members.has(String(parseInt(k, 10))))) { fail(`member_no ${no} is already used in this society.`); continue; }
      seenNo.add(k);
    }
    seenPhone.add(phone);
    if (ctx.members.has(phone)) { warnings.push({ line, warning: `${c.phone} is already a member, so this row will be skipped.` }); continue; }
    valid.push({ line, name, phone, memberNo: no || null, joinedOn: joined, exitedOn: exited, exitReason: cleanText(c.exit_reason, 200) || null, postcode: c.postcode || null });
  }
  return { valid, errors, warnings, totals: { rows: valid.length, exited: valid.filter(v => v.exitedOn).length } };
}

function validateLedger(dataset, rows, ctx) {
  const valid = [], errors = [], warnings = [];
  const seen = new Map();
  for (const { line, cells: c } of rows) {
    const fail = msg => errors.push({ line, error: msg });
    const m = resolveMember(ctx, c.member_no);
    if (!m) { fail(`No member matches "${c.member_no}". Load the members sheet first, and check the number.`); continue; }
    const day = parseFlexDay(c.date);
    if (!day) { fail('date must be a real date, YYYY-MM-DD or DD/MM/YYYY.'); continue; }
    if (!inWindow(ctx, day)) {
      fail(day < ctx.batch.fy_start
        ? `date ${day} is before the financial year start (${ctx.batch.fy_start}). Earlier activity belongs in the opening balances.`
        : `date ${day} ${windowMsg(ctx)}.`);
      continue;
    }
    let type = 'in';
    if (dataset === 'shares') {
      const t = String(c.type || 'purchase').trim().toLowerCase();
      if (!['purchase', 'withdrawal'].includes(t)) { fail('type must be purchase or withdrawal.'); continue; }
      type = t === 'withdrawal' ? 'out' : 'in';
    }
    const kobo = parseNaira(c.amount);
    if (kobo == null || kobo <= 0) { fail(`amount "${c.amount}" must be a positive naira figure.`); continue; }
    const src = sourceFromMethod(c.method);
    if (src.error) { fail(src.error); continue; }
    const reference = cleanText(c.reference, 100) || null;
    if (src.source === 'cash_in_person' && !reference) { fail('A reference (receipt number) is required for a cash row.'); continue; }
    const dupKey = [m.id, day, kobo, type, reference || ''].join('|');
    if (reference && seen.has(dupKey)) { fail(`Same member, date, amount and reference as line ${seen.get(dupKey)}. Remove the duplicate.`); continue; }
    if (!reference && seen.has(dupKey)) warnings.push({ line, warning: `Looks the same as line ${seen.get(dupKey)} (same member, date and amount). Check it is not a duplicate.` });
    if (!seen.has(dupKey)) seen.set(dupKey, line);
    valid.push({ line, member: m, day, amountKobo: kobo, type, source: src.source, reference });
  }
  const sum = valid.reduce((s, v) => s + (v.type === 'out' ? -v.amountKobo : v.amountKobo), 0);
  return { valid, errors, warnings, totals: { rows: valid.length, amount_kobo: sum } };
}

const LOAN_METHODS = { flat: 'flat', reducing_emi: 'reducing_balance_emi', reducing: 'reducing_balance_emi', reducing_declining: 'reducing_balance_declining' };

function computeLoanTerms(principalKobo, method, rate, months, disbursedDay) {
  const at = new Date(stamp(disbursedDay));
  if (method === 'flat') {
    const interestKobo = Math.round(principalKobo * (rate / 100));
    const total = principalKobo + interestKobo;
    return { interestKobo, totalRepayableKobo: total, schedule: generateRepaymentSchedule(total, months, at), reducingRate: null };
  }
  const gen = method === 'reducing_balance_declining' ? generateDecliningPrincipalSchedule : generateEmiSchedule;
  const r = gen(principalKobo, rate, months, at);
  return { interestKobo: r.totalInterestKobo, totalRepayableKobo: r.totalRepayableKobo, schedule: r.schedule, reducingRate: rate };
}

function validateLoans(rows, ctx) {
  const valid = [], errors = [], warnings = [];
  const seen = new Set();
  for (const { line, cells: c } of rows) {
    const fail = msg => errors.push({ line, error: msg });
    const ref = cleanText(c.loan_ref, 60);
    if (!ref) { fail('loan_ref is required.'); continue; }
    const key = ref.toLowerCase();
    if (seen.has(key)) { fail(`loan_ref ${ref} appears twice in this sheet.`); continue; }
    if (ctx.loansByRef.has(key)) { fail(`loan_ref ${ref} is already loaded in this batch.`); continue; }
    const m = resolveMember(ctx, c.member_no);
    if (!m) { fail(`No member matches "${c.member_no}".`); continue; }
    const principal = parseNaira(c.principal);
    if (principal == null || principal <= 0) { fail(`principal "${c.principal}" must be a positive naira figure.`); continue; }
    const methodKey = String(c.interest_method || 'flat').trim().toLowerCase();
    const method = LOAN_METHODS[methodKey];
    if (!method) { fail('interest_method must be flat, reducing_emi or reducing_declining.'); continue; }
    const rate = c.interest_rate_percent === '' ? 0 : Number(String(c.interest_rate_percent).replace('%', ''));
    if (!Number.isFinite(rate) || rate < 0 || rate > 1000) { fail(`interest_rate_percent "${c.interest_rate_percent}" is not a valid percentage.`); continue; }
    const months = Number(c.term_months);
    if (!Number.isInteger(months) || months < 1 || months > 120) { fail('term_months must be a whole number from 1 to 120.'); continue; }
    const day = parseFlexDay(c.disbursed_date);
    if (!day) { fail('disbursed_date must be a real date, YYYY-MM-DD or DD/MM/YYYY.'); continue; }
    if (day > ctx.batch.cutover_date) { fail(`disbursed_date cannot be after the cutover date (${ctx.batch.cutover_date}).`); continue; }
    let repaidBefore = 0;
    if (c.repaid_before_year !== '') {
      repaidBefore = parseNaira(c.repaid_before_year);
      if (repaidBefore == null) { fail(`repaid_before_year "${c.repaid_before_year}" must be a naira figure.`); continue; }
      if (repaidBefore > 0 && day >= ctx.batch.fy_start) { fail('repaid_before_year only applies to a loan lent before the financial year start. Put repayments in the repayments sheet.'); continue; }
    }
    const terms = computeLoanTerms(principal, method, rate, months, day);
    if (repaidBefore > terms.totalRepayableKobo) { fail(`repaid_before_year ${fmtNaira(repaidBefore)} is more than the whole loan repayable (${fmtNaira(terms.totalRepayableKobo)}).`); continue; }
    seen.add(key);
    valid.push({ line, ref, member: m, principalKobo: principal, method, rate, months, day, repaidBeforeKobo: repaidBefore, ...terms });
  }
  return { valid, errors, warnings, totals: { rows: valid.length, amount_kobo: valid.reduce((s, v) => s + v.principalKobo, 0) } };
}

function validateRepayments(rows, ctx) {
  const valid = [], errors = [], warnings = [];
  const seen = new Map();
  // Sort so the running total per loan follows the calendar, however the society ordered its sheet.
  const ordered = rows.slice().sort((a, b) => (parseFlexDay(a.cells.date) || '').localeCompare(parseFlexDay(b.cells.date) || '') || a.line - b.line);
  const running = new Map();
  for (const { line, cells: c } of ordered) {
    const fail = msg => errors.push({ line, error: msg });
    const loan = ctx.loansByRef.get(String(c.loan_ref || '').trim().toLowerCase());
    if (!loan) { fail(`No loan "${c.loan_ref}" in this batch. Load the loans sheet first.`); continue; }
    const day = parseFlexDay(c.date);
    if (!day) { fail('date must be a real date, YYYY-MM-DD or DD/MM/YYYY.'); continue; }
    if (!inWindow(ctx, day)) { fail(day < ctx.batch.fy_start ? `date ${day} is before the financial year start (${ctx.batch.fy_start}). Use repaid_before_year on the loan.` : `date ${day} ${windowMsg(ctx)}.`); continue; }
    if (day < String(loan.disbursed_at).slice(0, 10)) { fail(`date ${day} is before the loan was lent (${String(loan.disbursed_at).slice(0, 10)}).`); continue; }
    const kobo = parseNaira(c.amount);
    if (kobo == null || kobo <= 0) { fail(`amount "${c.amount}" must be a positive naira figure.`); continue; }
    const src = sourceFromMethod(c.method);
    if (src.error) { fail(src.error); continue; }
    const reference = cleanText(c.reference, 100) || null;
    if (src.source === 'cash_in_person' && !reference) { fail('A reference (receipt number) is required for a cash row.'); continue; }
    let principalPart = null, interestPart = null;
    if (c.principal_part !== '' || c.interest_part !== '') {
      principalPart = parseNaira(c.principal_part); interestPart = parseNaira(c.interest_part);
      if (principalPart == null || interestPart == null) { fail('Give both principal_part and interest_part as naira figures, or leave both blank.'); continue; }
      if (principalPart + interestPart !== kobo) { fail(`principal_part + interest_part (${fmtNaira(principalPart + interestPart)}) must equal the amount (${fmtNaira(kobo)}).`); continue; }
    }
    const paid = (running.get(loan.id) ?? ctx.paidByLoan.get(loan.id) ?? 0);
    if (paid + kobo > loan.total_repayable_kobo) { fail(`This would take repayments on ${loan.import_ref} to ${fmtNaira(paid + kobo)}, above the ${fmtNaira(loan.total_repayable_kobo)} repayable.`); continue; }
    running.set(loan.id, paid + kobo);
    const dupKey = [loan.id, day, kobo, reference || ''].join('|');
    if (reference && seen.has(dupKey)) { fail(`Same loan, date, amount and reference as line ${seen.get(dupKey)}. Remove the duplicate.`); running.set(loan.id, paid); continue; }
    if (!seen.has(dupKey)) seen.set(dupKey, line);
    valid.push({ line, loan, day, amountKobo: kobo, source: src.source, reference, principalPart, interestPart });
  }
  valid.sort((a, b) => a.line - b.line);
  return { valid, errors, warnings, totals: { rows: valid.length, amount_kobo: valid.reduce((s, v) => s + v.amountKobo, 0) } };
}

function validate(dataset, rows, ctx) {
  if (dataset === 'members') return validateMembers(rows, ctx);
  if (dataset === 'loans') return validateLoans(rows, ctx);
  if (dataset === 'loan_repayments') return validateRepayments(rows, ctx);
  return validateLedger(dataset, rows, ctx);
}

// ───────────────────────────── context ─────────────────────────────

async function loadContext(db, coopId, batch, { dataset, replace } = {}) {
  const members = new Map();
  const list = await fetchAllRows(() => db.from('coop_members').select('id, name, member_number, phone_normalized, status').eq('coop_id', coopId).order('id'));
  // Replacing the members sheet: this batch's own members are about to be cleared, so they must not count as taken.
  let batchMemberIds = new Set();
  if (dataset === 'members' && replace) {
    const mine = await fetchAllRows(() => db.from('coop_members').select('id').eq('coop_id', coopId).eq('migration_batch_id', batch.id).order('id'));
    batchMemberIds = new Set(mine.map(r => r.id));
  }
  for (const m of list) { if (batchMemberIds.has(m.id)) continue; for (const k of memberKeys(m)) if (!members.has(k)) members.set(k, m); }

  const loansByRef = new Map(), paidByLoan = new Map();
  if (dataset === 'loans' || dataset === 'loan_repayments') {
    const loans = await fetchAllRows(() => db.from('coop_loans')
      .select('id, import_ref, member_id, principal_kobo, interest_kobo, total_repayable_kobo, interest_method, repayment_months, disbursed_at, status')
      .eq('coop_id', coopId).eq('migration_batch_id', batch.id).order('id'));
    // Replacing the loans sheet: this batch's own loans are about to be cleared, so their references are free again.
    if (!(dataset === 'loans' && replace)) for (const l of loans) if (l.import_ref) loansByRef.set(l.import_ref.toLowerCase(), l);
    if (dataset === 'loan_repayments' && loans.length) {
      for (const ids of chunk(loans.map(l => l.id))) {
        const reps = await fetchAllRows(() => db.from('coop_loan_repayments').select('loan_id, amount_kobo, source').in('loan_id', ids).order('id'));
        for (const r of reps) {
          if (replace && r.source !== 'migration_opening') continue;   // those are about to be replaced
          paidByLoan.set(r.loan_id, (paidByLoan.get(r.loan_id) || 0) + r.amount_kobo);
        }
      }
    }
  }
  return { coopId, batch, members, loansByRef, paidByLoan };
}

// ───────────────────────────── journals ─────────────────────────────

async function postJournalBatch(db, coopId, entries, createdBy, { batchId, dataset }) {
  if (!entries.length) return { count: 0 };
  const start = await nextEntryNumber(db, coopId);
  const headers = entries.map((e, i) => ({
    coop_id: coopId, entry_number: start + i, entry_date: e.date, description: e.description,
    entry_type: 'manual', created_by: createdBy, migration_batch_id: batchId, migration_dataset: dataset,
  }));
  const ids = [];
  try {
    for (const part of chunk(headers, 200)) {
      const { data, error } = await db.from('coop_journal_entries').insert(part).select('id, entry_number');
      if (error) throw new Error(error.message);
      ids.push(...(data || []));
    }
    const byNo = new Map(ids.map(r => [r.entry_number, r.id]));
    const lines = [];
    entries.forEach((e, i) => {
      const id = byNo.get(start + i);
      for (const l of e.lines) lines.push({ journal_entry_id: id, coop_id: coopId, account_id: l.account.id, line_type: l.type, amount: l.amountKobo, currency: l.account.currency, exchange_rate: 1, base_amount: l.amountKobo, memo: e.description });
    });
    for (const part of chunk(lines, 500)) {
      const { error } = await db.from('coop_journal_entry_lines').insert(part);
      if (error) throw new Error(error.message);
    }
    return { count: entries.length };
  } catch (e) {
    const done = ids.map(r => r.id);
    for (const part of chunk(done)) {
      await db.from('coop_journal_entry_lines').delete().in('journal_entry_id', part);
      await db.from('coop_journal_entries').delete().in('id', part);
    }
    throw new Error(`Could not book the journal entries (${e.message}). Nothing from this upload was kept.`);
  }
}

const who = m => (m && m.name ? `${m.name} (Member #${String(m.id).slice(0, 8)})` : `Member #${String(m && m.id).slice(0, 8)}`);
const viaLabel = s => (s === 'cash_in_person' ? 'Cash (in person)' : 'Bank transfer (recorded manually)');
const cashOrBank = (acc, source) => (source === 'cash_in_person' ? acc[CASH] : acc[BANK]);

async function journalContext(db, coopId, codes) {
  if (!(await accountingIsReady(db, coopId))) return { ready: false };
  const acc = await getAccounts(db, coopId, codes);
  const missing = codes.filter(c => !acc[c]);
  if (missing.length) return { ready: false, reason: `the chart of accounts is missing ${missing.join(', ')}` };
  return { ready: true, acc };
}

// ───────────────────────────── applying ─────────────────────────────

async function applyMembers(db, ctx, valid, actor) {
  const cap = await checkMemberCapAllows(db, ctx.coopId, valid.filter(v => !v.exitedOn).length);
  if (!cap.ok) throw new Error(cap.error);
  const results = [], errors = [];
  for (const v of valid) {
    const r = await activateMember(db, {
      coopId: ctx.coopId, rawPhone: v.phone, name: v.name, openingBalanceKobo: 0, activatedBy: actor, postcode: v.postcode,
      joinedOn: v.joinedOn, exitedOn: v.exitedOn, exitReason: v.exitReason, migrationBatchId: ctx.batch.id, memberNumber: v.memberNo,
    });
    if (r.status === 'created') results.push(v.line);
    else if (r.status === 'already_existed') errors.push({ line: v.line, error: 'Already a member, skipped.' });
    else errors.push({ line: v.line, error: r.error });
  }
  return { applied: results.length, extraErrors: errors, journals: { posted: 0, skipped: null } };
}

async function applyLedger(db, ctx, dataset, valid, actor) {
  const table = { shares: 'coop_share_transactions', savings: 'coop_savings_transactions', dues: 'coop_dues_transactions' }[dataset];
  const codes = dataset === 'shares' ? [CASH, BANK, SHARE_CAPITAL] : dataset === 'savings' ? [CASH, BANK, SAVINGS_PAYABLE] : [CASH, BANK, DUES_RECEIVABLE];
  const jc = await journalContext(db, ctx.coopId, codes);

  let planByMember = new Map();
  const createdPlanIds = [];
  if (dataset === 'savings') {
    const memberIds = [...new Set(valid.map(v => v.member.id))];
    for (const ids of chunk(memberIds)) {
      const plans = await fetchAllRows(() => db.from('coop_savings_plans').select('id, member_id, created_at, status').eq('coop_id', ctx.coopId).in('member_id', ids).order('id'));
      for (const p of plans.filter(p => p.status === 'ACTIVE').sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))) if (!planByMember.has(p.member_id)) planByMember.set(p.member_id, p.id);
    }
    const need = memberIds.filter(id => !planByMember.has(id));
    if (need.length) {
      const totals = new Map();
      for (const v of valid) totals.set(v.member.id, (totals.get(v.member.id) || 0) + v.amountKobo);
      const rows = need.map(id => ({
        coop_id: ctx.coopId, member_id: id, target_amount_kobo: Math.max(1, totals.get(id) || 1), monthly_contribution_kobo: 0, duration_months: 12,
        start_date: ctx.batch.fy_start, status: 'ACTIVE', created_by: `go_live:${ctx.batch.id}`,
      }));
      for (const part of chunk(rows, 200)) {
        const { data, error } = await db.from('coop_savings_plans').insert(part).select('id, member_id');
        if (error) throw new Error(`Could not create savings plans for imported deposits: ${error.message}`);
        for (const p of data || []) { planByMember.set(p.member_id, p.id); createdPlanIds.push(p.id); }
      }
    }
  }

  const rows = valid.map(v => ({
    coop_id: ctx.coopId, member_id: v.member.id, amount_kobo: v.type === 'out' ? -v.amountKobo : v.amountKobo,
    source: v.source, reference: v.reference, recorded_by: actor, recorded_at: stamp(v.day), migration_batch_id: ctx.batch.id,
    ...(dataset === 'savings' ? { savings_plan_id: planByMember.get(v.member.id) } : {}),
  }));
  const insertedIds = [];
  try {
    for (const part of chunk(rows, 200)) {
      const { data, error } = await db.from(table).insert(part).select('id');
      if (error) throw new Error(error.message);
      insertedIds.push(...(data || []).map(r => r.id));
    }
    let posted = 0;
    if (jc.ready) {
      const entries = valid.map(v => {
        const a = cashOrBank(jc.acc, v.source), other = jc.acc[{ shares: SHARE_CAPITAL, savings: SAVINGS_PAYABLE, dues: DUES_RECEIVABLE }[dataset]];
        const kind = dataset === 'shares' ? (v.type === 'out' ? 'Share capital withdrawal' : 'Share capital contribution') : dataset === 'savings' ? 'Savings payment received' : 'Dues payment received';
        const out = v.type === 'out';
        return {
          date: v.day, description: `${kind} — ${who(v.member)} via ${viaLabel(v.source)}`,
          lines: [{ account: out ? other : a, type: 'debit', amountKobo: v.amountKobo }, { account: out ? a : other, type: 'credit', amountKobo: v.amountKobo }],
        };
      });
      posted = (await postJournalBatch(db, ctx.coopId, entries, actor, { batchId: ctx.batch.id, dataset })).count;
    }
    return { applied: valid.length, extraErrors: [], journals: { posted, skipped: jc.ready ? null : (jc.reason || 'accounting is not set up yet') } };
  } catch (e) {
    for (const part of chunk(insertedIds)) await db.from(table).delete().in('id', part);
    if (createdPlanIds.length) for (const part of chunk(createdPlanIds)) await db.from('coop_savings_plans').delete().in('id', part);
    throw e;
  }
}

async function applyLoans(db, ctx, valid, actor) {
  const jc = await journalContext(db, ctx.coopId, [BANK, LOAN_PRINCIPAL, LOAN_INTEREST, INTEREST_INCOME]);
  const loanRows = valid.map(v => ({
    coop_id: ctx.coopId, member_id: v.member.id, principal_kobo: v.principalKobo, interest_rate_percent: v.rate, interest_kobo: v.interestKobo,
    total_repayable_kobo: v.totalRepayableKobo, repayment_months: v.months, monthly_repayment_kobo: Math.ceil(v.totalRepayableKobo / v.months),
    status: 'DISBURSED', requested_at: stamp(v.day), approved_at: stamp(v.day), approved_by: 'go_live_import', disbursed_at: stamp(v.day),
    interest_method: v.method, reducing_balance_monthly_rate_percent: v.reducingRate, migration_batch_id: ctx.batch.id, import_ref: v.ref,
  }));
  const created = [];
  try {
    for (const part of chunk(loanRows, 100)) {
      const { data, error } = await db.from('coop_loans').insert(part).select('id, import_ref');
      if (error) throw new Error(error.message);
      created.push(...(data || []));
    }
    const idByRef = new Map(created.map(l => [l.import_ref.toLowerCase(), l.id]));
    const schedule = [];
    for (const v of valid) for (const p of v.schedule) schedule.push({ loan_id: idByRef.get(v.ref.toLowerCase()), ...p });
    for (const part of chunk(schedule, 500)) {
      const { error } = await db.from('coop_loan_repayment_schedule').insert(part);
      if (error) throw new Error(`Could not build repayment schedules: ${error.message}`);
    }
    // Repaid before the year began: one marker repayment dated the day before, no journal (the opening balances hold it).
    const before = valid.filter(v => v.repaidBeforeKobo > 0).map(v => {
      const split = v.method === 'flat'
        ? computeRepaymentSplit(v.repaidBeforeKobo, v.interestKobo, v.totalRepayableKobo, 0)
        : computeReducingBalanceSplit(v.schedule, 0, v.repaidBeforeKobo);
      const d = new Date(ctx.batch.fy_start + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1);
      return { loan_id: idByRef.get(v.ref.toLowerCase()), amount_kobo: v.repaidBeforeKobo, source: 'migration_opening', reference: 'Repaid before the financial year', recorded_by: actor,
        recorded_at: stamp(d.toISOString().slice(0, 10)), principal_portion_kobo: split.principalPortionKobo, interest_portion_kobo: split.interestPortionKobo, migration_batch_id: ctx.batch.id };
    });
    for (const part of chunk(before, 200)) {
      const { error } = await db.from('coop_loan_repayments').insert(part);
      if (error) throw new Error(`Could not record repayments made before the year: ${error.message}`);
    }
    let posted = 0;
    if (jc.ready) {
      const entries = valid.filter(v => v.day >= ctx.batch.fy_start).map(v => {
        const lines = [{ account: jc.acc[LOAN_PRINCIPAL], type: 'debit', amountKobo: v.principalKobo }];
        if (v.interestKobo > 0) lines.push({ account: jc.acc[LOAN_INTEREST], type: 'debit', amountKobo: v.interestKobo });
        lines.push({ account: jc.acc[BANK], type: 'credit', amountKobo: v.principalKobo });
        if (v.interestKobo > 0) lines.push({ account: jc.acc[INTEREST_INCOME], type: 'credit', amountKobo: v.interestKobo });
        return { date: v.day, description: `Loan disbursed — ${who(v.member)} (${v.ref})`, lines };
      });
      posted = (await postJournalBatch(db, ctx.coopId, entries, actor, { batchId: ctx.batch.id, dataset: 'loans' })).count;
    }
    await refreshLoanStatuses(db, created.map(l => l.id));
    return { applied: valid.length, extraErrors: [], journals: { posted, skipped: jc.ready ? null : (jc.reason || 'accounting is not set up yet') } };
  } catch (e) {
    const ids = created.map(l => l.id);
    for (const part of chunk(ids)) {
      await db.from('coop_loan_repayments').delete().in('loan_id', part);
      await db.from('coop_loan_repayment_schedule').delete().in('loan_id', part);
      await db.from('coop_loans').delete().in('id', part);
    }
    throw e;
  }
}

async function applyRepayments(db, ctx, valid, actor) {
  const jc = await journalContext(db, ctx.coopId, [CASH, BANK, LOAN_PRINCIPAL, LOAN_INTEREST]);
  const loanIds = [...new Set(valid.map(v => v.loan.id))];
  const schedules = new Map();
  for (const ids of chunk(loanIds)) {
    const rows = await fetchAllRows(() => db.from('coop_loan_repayment_schedule').select('loan_id, period_number, principal_due_kobo, interest_due_kobo').in('loan_id', ids).order('id'));
    for (const r of rows) { if (!schedules.has(r.loan_id)) schedules.set(r.loan_id, []); schedules.get(r.loan_id).push(r); }
  }
  const paid = new Map(ctx.paidByLoan), interestPaid = new Map();
  const ordered = valid.slice().sort((a, b) => a.day.localeCompare(b.day) || a.line - b.line);
  const rows = ordered.map(v => {
    const L = v.loan;
    let p = v.principalPart, i = v.interestPart;
    if (p == null) {
      const reducing = L.interest_method === 'reducing_balance_emi' || L.interest_method === 'reducing_balance_declining';
      const s = reducing
        ? computeReducingBalanceSplit((schedules.get(L.id) || []).sort((a, b) => a.period_number - b.period_number), paid.get(L.id) || 0, v.amountKobo)
        : computeRepaymentSplit(v.amountKobo, L.interest_kobo, L.total_repayable_kobo, interestPaid.get(L.id) || 0);
      p = s.principalPortionKobo; i = s.interestPortionKobo;
    }
    paid.set(L.id, (paid.get(L.id) || 0) + v.amountKobo);
    interestPaid.set(L.id, (interestPaid.get(L.id) || 0) + i);
    return { v, row: { loan_id: L.id, amount_kobo: v.amountKobo, source: v.source, reference: v.reference, recorded_by: actor, recorded_at: stamp(v.day), principal_portion_kobo: p, interest_portion_kobo: i, migration_batch_id: ctx.batch.id } };
  });
  const insertedIds = [];
  try {
    for (const part of chunk(ordered.map((_, k) => rows[k].row), 200)) {
      const { data, error } = await db.from('coop_loan_repayments').insert(part).select('id');
      if (error) throw new Error(error.message);
      insertedIds.push(...(data || []).map(r => r.id));
    }
    let posted = 0;
    if (jc.ready) {
      const memberOf = new Map([...ctx.members.values()].map(m => [m.id, m]));
      const entries = rows.map(({ v, row }) => {
        const a = cashOrBank(jc.acc, v.source);
        const lines = [{ account: a, type: 'debit', amountKobo: v.amountKobo }, { account: jc.acc[LOAN_PRINCIPAL], type: 'credit', amountKobo: row.principal_portion_kobo }];
        if (row.interest_portion_kobo > 0) lines.push({ account: jc.acc[LOAN_INTEREST], type: 'credit', amountKobo: row.interest_portion_kobo });
        return { date: v.day, description: `Loan repayment received — ${who(memberOf.get(v.loan.member_id) || { id: v.loan.member_id })} via ${viaLabel(v.source)} (${v.loan.import_ref})`, lines };
      });
      posted = (await postJournalBatch(db, ctx.coopId, entries, actor, { batchId: ctx.batch.id, dataset: 'loan_repayments' })).count;
    }
    await refreshLoanStatuses(db, loanIds);
    return { applied: valid.length, extraErrors: [], journals: { posted, skipped: jc.ready ? null : (jc.reason || 'accounting is not set up yet') } };
  } catch (e) {
    for (const part of chunk(insertedIds)) await db.from('coop_loan_repayments').delete().in('id', part);
    await refreshLoanStatuses(db, loanIds);
    throw e;
  }
}

/** DISBURSED with nothing paid, REPAYING part paid, COMPLETED fully paid. Only touches loans of a draft batch. */
async function refreshLoanStatuses(db, loanIds) {
  for (const ids of chunk(loanIds)) {
    const loans = await fetchAllRows(() => db.from('coop_loans').select('id, total_repayable_kobo').in('id', ids).order('id'));
    const reps = await fetchAllRows(() => db.from('coop_loan_repayments').select('loan_id, amount_kobo').in('loan_id', ids).order('id'));
    const paid = new Map();
    for (const r of reps) paid.set(r.loan_id, (paid.get(r.loan_id) || 0) + r.amount_kobo);
    for (const l of loans) {
      const p = paid.get(l.id) || 0;
      const status = p >= l.total_repayable_kobo ? 'COMPLETED' : p > 0 ? 'REPAYING' : 'DISBURSED';
      await db.from('coop_loans').update({ status }).eq('id', l.id);
    }
  }
}

const APPLY = { members: applyMembers, loans: applyLoans, loan_repayments: applyRepayments };

/** Validates and, unless dryRun, applies one sheet. Never throws for bad rows: they come back as errors. */
async function runImport(db, { coopId, batch, dataset, text, dryRun = true, replace = false, actor }) {
  const spec = DATASETS[dataset];
  if (!spec) return { ok: false, status: 400, error: `Unknown sheet "${dataset}". Use one of: ${ORDER.join(', ')}.` };
  const parsed = parseSheet(dataset, text);
  if (parsed.error) return { ok: false, status: 400, error: parsed.error };
  if (parsed.rows.length === 0) return { ok: false, status: 400, error: 'The sheet has a header but no rows.' };
  if (parsed.rows.length > MAX_ROWS[dataset]) return { ok: false, status: 400, error: `${parsed.rows.length} rows is too many for one upload. The limit for ${spec.title} is ${MAX_ROWS[dataset]}. Split the sheet and upload the parts one after another.` };

  const ctx = await loadContext(db, coopId, batch, { dataset, replace });
  const result = validate(dataset, parsed.rows, ctx);
  const out = {
    ok: true, dataset, mode: dryRun ? 'dry_run' : 'applied', rows_read: parsed.rows.length,
    accepted: result.valid.length, rejected: result.errors.length, errors: result.errors.sort((a, b) => a.line - b.line), warnings: result.warnings, totals: result.totals,
  };
  if (dryRun) return out;
  if (result.errors.length) return { ...out, ok: false, status: 422, mode: 'blocked', error: `${result.errors.length} row${result.errors.length === 1 ? '' : 's'} need fixing. Nothing was loaded.` };
  if (!result.valid.length) return { ...out, ok: false, status: 422, mode: 'blocked', error: 'There is nothing new to load.' };

  try {
    if (replace) await clearDataset(db, batch, dataset);
    const applied = await (APPLY[dataset] || ((d, c, v, a) => applyLedger(d, c, dataset, v, a)))(db, ctx, result.valid, actor);
    return { ...out, applied: applied.applied, errors: [...out.errors, ...applied.extraErrors], journals: applied.journals };
  } catch (e) {
    return { ...out, ok: false, status: 500, mode: 'failed', error: e.message };
  }
}

// ───────────────────────────── clearing and counting ─────────────────────────────

async function deleteJournals(db, batchId, dataset) {
  const rows = await fetchAllRows(() => db.from('coop_journal_entries').select('id').eq('migration_batch_id', batchId).eq('migration_dataset', dataset).order('id'));
  for (const part of chunk(rows.map(r => r.id))) {
    await db.from('coop_journal_entry_lines').delete().in('journal_entry_id', part);
    await db.from('coop_journal_entries').delete().in('id', part);
  }
}

async function countBatch(db, batchId) {
  const head = t => db.from(t).select('id', { count: 'exact', head: true }).eq('migration_batch_id', batchId);
  const [m, s, sv, d, l, r] = await Promise.all([
    head('coop_members'), head('coop_share_transactions'), head('coop_savings_transactions'), head('coop_dues_transactions'), head('coop_loans'),
    head('coop_loan_repayments').neq('source', 'migration_opening'),
  ]);
  return { members: m.count || 0, shares: s.count || 0, savings: sv.count || 0, dues: d.count || 0, loans: l.count || 0, loan_repayments: r.count || 0 };
}

/** Removes one sheet's rows (and their journals) from a draft batch. Refuses to pull the rug from sheets that depend on it. */
async function clearDataset(db, batch, dataset) {
  if (batch.status !== 'draft') throw new Error(`This batch is ${batch.status}. Only a draft batch can be changed.`);
  const counts = await countBatch(db, batch.id);
  const deps = { members: ['shares', 'savings', 'dues', 'loans', 'loan_repayments'], loans: ['loan_repayments'] }[dataset] || [];
  const blocking = deps.filter(d => counts[d] > 0);
  if (blocking.length) throw new Error(`Clear ${blocking.join(' and ')} first, because they depend on ${dataset}.`);

  if (dataset === 'members') {
    await db.from('coop_savings_plans').delete().eq('created_by', `go_live:${batch.id}`);
    await db.from('coop_members').delete().eq('migration_batch_id', batch.id);
  } else if (dataset === 'shares' || dataset === 'dues') {
    await deleteJournals(db, batch.id, dataset);
    await db.from(dataset === 'shares' ? 'coop_share_transactions' : 'coop_dues_transactions').delete().eq('migration_batch_id', batch.id);
  } else if (dataset === 'savings') {
    await deleteJournals(db, batch.id, 'savings');
    await db.from('coop_savings_transactions').delete().eq('migration_batch_id', batch.id);
    await db.from('coop_savings_plans').delete().eq('created_by', `go_live:${batch.id}`);
  } else if (dataset === 'loans') {
    const loans = await fetchAllRows(() => db.from('coop_loans').select('id').eq('migration_batch_id', batch.id).order('id'));
    await deleteJournals(db, batch.id, 'loans');
    for (const part of chunk(loans.map(l => l.id))) {
      await db.from('coop_loan_repayments').delete().in('loan_id', part);
      await db.from('coop_loan_repayment_schedule').delete().in('loan_id', part);
      await db.from('coop_loans').delete().in('id', part);
    }
  } else if (dataset === 'loan_repayments') {
    const loans = await fetchAllRows(() => db.from('coop_loans').select('id').eq('migration_batch_id', batch.id).order('id'));
    await deleteJournals(db, batch.id, 'loan_repayments');
    await db.from('coop_loan_repayments').delete().eq('migration_batch_id', batch.id).neq('source', 'migration_opening');
    await refreshLoanStatuses(db, loans.map(l => l.id));
  } else {
    throw new Error(`Unknown sheet "${dataset}".`);
  }
}

// ───────────────────────────── templates ─────────────────────────────

const csvCell = v => (/[",\n\t;]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

function buildTemplate(dataset) {
  const spec = DATASETS[dataset];
  if (!spec) return null;
  const header = spec.columns.map(c => c.name).join(',');
  const body = spec.examples.map(r => r.map(csvCell).join(',')).join('\n');
  return {
    dataset, title: spec.title, filename: `zillion-go-live-${dataset.replace(/_/g, '-')}-template.csv`,
    csv: header + '\n' + body + '\n',
    columns: spec.columns.map(c => ({ name: c.name, required: c.required, help: c.help })),
    max_rows: MAX_ROWS[dataset],
  };
}

module.exports = {
  ORDER, DATASETS, MAX_ROWS, parseSheet, parseFlexDay, parseNaira, validate, loadContext, runImport, clearDataset, countBatch, buildTemplate,
  postJournalBatch, refreshLoanStatuses, resolveMember,
};
