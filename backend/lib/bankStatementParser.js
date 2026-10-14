/**
 * zillion/backend/lib/bankStatementParser.js
 *
 * Reads a bank statement - a PDF the bank generated, or an Excel / CSV export - into one shape the reconciliation understands:
 *
 *   { meta: { account_name, account_number, period_from, period_to, currency },
 *     opening_balance_kobo, closing_balance_kobo,
 *     lines: [{ date, value_date, description, amount_kobo, direction: 'credit'|'debit', balance_kobo }],
 *     integrity: { ... }, warnings: [] }
 *
 * WHY THE BALANCES COME FROM THE FILE. Asking a person to type the opening and closing balance invites a typo that then shows up
 * as a phantom difference. A bank statement already states both, and every line carries a running balance, so the file can PROVE
 * itself: each balance must equal the one before it plus the credit or minus the debit, and the lines must add up to the totals the
 * bank prints. If a line was misread, dropped or double counted, the chain breaks and we say exactly where, instead of importing
 * something quietly wrong. Money is integer kobo throughout: amounts are parsed from their text, never through floating point.
 *
 * Pure functions, except extractPdfPages (which reads the PDF). Nothing here touches the database.
 */
'use strict';

class StatementParseError extends Error {}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

const pad2 = n => String(n).padStart(2, '0');
function iso(y, m, d) {
  if (y < 100) y += 2000;
  if (!(y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null; // 31 Feb and friends
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** A date as written on a statement -> 'YYYY-MM-DD', or null if the text is not a date. Day comes first when it is ambiguous (Nigeria). */
function parseDate(v) {
  if (v == null) return null;
  if (v instanceof Date && !isNaN(v)) return iso(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
  if (typeof v === 'number') {                       // an Excel date serial
    if (v > 30000 && v < 80000) { const d = new Date(Math.round((v - 25569) * 86400000)); return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); }
    return null;
  }
  const s = String(v).trim();
  let m;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/))) return iso(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[-/. ]([A-Za-z]{3,9})[-/. ,]*(\d{2,4})$/))) { const mo = MONTHS[m[2].toLowerCase()]; return mo ? iso(+m[3], mo, +m[1]) : null; }
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:\s.*)?$/))) return iso(+m[3], +m[2], +m[1]);
  if (/^\d{5}$/.test(s)) return parseDate(Number(s));
  return null;
}

/**
 * Money as written -> integer kobo, or null if it is not money. Handles 1,234.50  -1,234.50  (1,234.50)  ₦1,234.50  1234.5  and a
 * trailing CR / DR (DR = negative). More than two decimals is not money here (it is more likely a reference number).
 */
function parseMoneyToKobo(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) : null;
  let s = String(v).trim();
  if (!s || s === '-' || s === '--') return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
  const tail = s.match(/\s*(cr|dr)\.?$/i);
  if (tail) { if (tail[1].toLowerCase() === 'dr') neg = !neg; s = s.slice(0, tail.index).trim(); }
  s = s.replace(/^(ngn|n|₦)\s*/i, '').replace(/\s+/g, '');
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  if (!/^\d[\d,]*(\.\d{1,2})?$|^\.\d{1,2}$/.test(s)) return null;
  if (/,/.test(s) && !/^\d{1,3}(,\d{3})*(\.\d{1,2})?$/.test(s)) return null; // 1,23,456 or 12,34 - not a figure we can trust
  const [whole, frac = ''] = s.replace(/,/g, '').split('.');
  const kobo = Number(whole || '0') * 100 + Number((frac + '00').slice(0, 2));
  if (!Number.isSafeInteger(kobo)) return null;
  return neg ? -kobo : kobo;
}

const AMOUNT_TOKEN = /^\(?[-+]?(?:ngn|n|₦)?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?\)?(?:\s*(?:cr|dr)\.?)?$/i;
const looksLikeAmount = s => AMOUNT_TOKEN.test(String(s).trim()) && parseMoneyToKobo(s) !== null;

const OPENING_RE = /\b(opening\s+balance|balance\s+(?:b\/?f|brought\s+forward)|brought\s+forward|b\/f)\b/i;
const FOOTER_LABELS = [
  [/^total\s+(?:debits?|withdrawals?|dr)\b/i, 'debits'],
  [/^total\s+(?:credits?|deposits?|cr)\b/i, 'credits'],
  [/^(?:closing\s+balance|balance\s+c\/?f|balance\s+carried\s+forward)\b/i, 'closing'],
];

function metaFromText(text) {
  const out = {};
  let m;
  if ((m = text.match(/account\s*(?:name|title)\s*[:\-]\s*(.+?)(?=\s{2,}|\s+account\s*(?:no|number|num)|\s+currency|\s*$)/i))) out.account_name = m[1].trim();
  if ((m = text.match(/account\s*(?:no\.?|number|num\.?)\s*[:\-]?\s*(\d[\d\s-]{6,16}\d)/i))) out.account_number = m[1].replace(/\D/g, '');
  if ((m = text.match(/currency\s*[:\-]?\s*([A-Za-z]{3})\b/i))) out.currency = m[1].toUpperCase();
  if ((m = text.match(/(?:statement\s*period|period|from)\s*[:\-]?\s*(\d{1,2}[-/. ][A-Za-z0-9]{1,9}[-/. ,]*\d{2,4}|\d{4}-\d{2}-\d{2})\s*(?:to|-|–|and)\s*(\d{1,2}[-/. ][A-Za-z0-9]{1,9}[-/. ,]*\d{2,4}|\d{4}-\d{2}-\d{2})/i))) {
    out.period_from = parseDate(m[1]); out.period_to = parseDate(m[2]);
  }
  return out;
}

// ── turning raw lines into a verified statement ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} p  { meta, opening, footer: {debits, credits, closing}, lines: [{ date, valueDate, description, debit, credit, signed, direction, balance, ref }] }
 *   Every money value is already kobo. A line gives EITHER debit/credit columns, OR a signed amount, OR an amount plus an explicit direction.
 */
function assemble(p) {
  const warnings = [];
  const problems = [];
  let lines = p.lines.map((l, i) => ({ ...l, n: l.n || i + 1 }));
  if (!lines.length) throw new StatementParseError('No transactions were found in this file. Check it is the statement itself and not a summary page.');

  // Some banks list the newest first. The running balance only makes sense oldest first, so put it the right way round.
  if (lines.length > 1 && lines[0].date > lines[lines.length - 1].date) { lines.reverse(); warnings.push('This statement lists the newest transaction first. It was read oldest first so the running balance could be checked.'); }

  const out = [];
  for (const l of lines) {
    let amount = null, direction = null, fromColumn = false;
    const d = l.debit || 0, c = l.credit || 0;
    if (l.debit != null || l.credit != null) {
      if (d && c) { problems.push({ line: l.n, date: l.date, description: l.description, issue: 'has both a debit and a credit amount' }); continue; }
      if (!d && !c) continue; // a row with a zero amount carries nothing to reconcile
      amount = Math.abs(d || c); direction = d ? 'debit' : 'credit'; fromColumn = true;
    } else if (l.signed != null) {
      if (l.signed === 0) continue;
      amount = Math.abs(l.signed);
      direction = l.direction || (l.signed < 0 ? 'debit' : 'credit'); fromColumn = !!l.direction || l.signed < 0;
    }
    out.push({ n: l.n, date: l.date, value_date: l.valueDate || null, description: (l.description || '').replace(/\s+/g, ' ').trim(), amount_kobo: amount, direction, balance_kobo: l.balance == null ? null : l.balance, _col: fromColumn });
  }
  if (!out.length) throw new StatementParseError('No transactions with an amount were found in this file.');

  const haveBalances = out.every(l => l.balance_kobo != null);
  let opening = Number.isInteger(p.opening) ? p.opening : null;

  // A balance column lets us fill in a direction the file did not state, and check the direction it did.
  if (haveBalances) {
    let prev = opening;
    for (const l of out) {
      if (prev != null && l.amount_kobo != null) {
        const delta = l.balance_kobo - prev;
        if (!l.direction) { l.direction = delta === l.amount_kobo ? 'credit' : delta === -l.amount_kobo ? 'debit' : null; }
      }
      prev = l.balance_kobo;
    }
  }
  const noDirection = out.filter(l => !l.direction);
  if (noDirection.length) throw new StatementParseError(`Could not tell whether ${noDirection.length} line(s) were money in or money out (first one: ${noDirection[0].date} ${noDirection[0].description.slice(0, 40)}). The file needs Debit and Credit columns, a Type column, or a running Balance.`);

  // The opening balance, if the statement did not print one, is the balance before the first line.
  if (opening == null && haveBalances) {
    const f = out[0]; opening = f.balance_kobo - (f.direction === 'credit' ? f.amount_kobo : -f.amount_kobo);
    warnings.push('The statement does not state an opening balance, so it was worked out from the first line.');
  }

  // THE PROOF: every balance follows from the one before it.
  let chainBreaks = 0;
  if (haveBalances && opening != null) {
    let prev = opening;
    for (const l of out) {
      const expected = prev + (l.direction === 'credit' ? l.amount_kobo : -l.amount_kobo);
      if (expected !== l.balance_kobo) {
        chainBreaks++;
        if (problems.length < 8) problems.push({ line: l.n, date: l.date, description: l.description, issue: `balance should be ${expected} kobo after this line but the statement shows ${l.balance_kobo}`, expected_kobo: expected, found_kobo: l.balance_kobo });
      }
      prev = l.balance_kobo; // continue from what the bank says, so one bad line is reported once
    }
  }

  const totalDebits = out.filter(l => l.direction === 'debit').reduce((s, l) => s + l.amount_kobo, 0);
  const totalCredits = out.filter(l => l.direction === 'credit').reduce((s, l) => s + l.amount_kobo, 0);
  const footer = p.footer || {};
  let totalsOk = null;
  if (footer.debits != null || footer.credits != null) {
    totalsOk = (footer.debits == null || footer.debits === totalDebits) && (footer.credits == null || footer.credits === totalCredits);
    if (!totalsOk) problems.push({ line: null, issue: `the lines add up to ${totalDebits} debits and ${totalCredits} credits (kobo) but the statement's own totals are ${footer.debits ?? 'n/a'} and ${footer.credits ?? 'n/a'}`, found_kobo: null });
  }

  const lastBalance = haveBalances ? out[out.length - 1].balance_kobo : null;
  let closing = Number.isInteger(footer.closing) ? footer.closing : lastBalance;
  if (Number.isInteger(footer.closing) && lastBalance != null && footer.closing !== lastBalance) {
    problems.push({ line: null, issue: `the last running balance (${lastBalance} kobo) is not the closing balance the statement prints (${footer.closing} kobo)` });
  }
  if (closing == null && opening != null) { closing = opening + totalCredits - totalDebits; warnings.push('No closing balance was found, so it was worked out from the opening balance and the lines.'); }
  if (opening != null && closing != null && haveBalances === false && footer.closing != null && opening + totalCredits - totalDebits !== closing) {
    problems.push({ line: null, issue: `opening balance plus credits minus debits (${opening + totalCredits - totalDebits} kobo) is not the closing balance (${closing} kobo)` });
  }
  if (!haveBalances) warnings.push('This file has no running balance column, so the individual lines could not be checked against each other.');

  const dates = out.map(l => l.date).sort();
  const meta = { account_name: null, account_number: null, currency: null, period_from: null, period_to: null, ...(p.meta || {}) };
  if (!meta.period_from) meta.period_from = dates[0];
  if (!meta.period_to) meta.period_to = dates[dates.length - 1];

  return {
    meta,
    opening_balance_kobo: opening,
    closing_balance_kobo: closing,
    balances_source: (opening != null && closing != null && (haveBalances || footer.closing != null || Number.isInteger(p.opening))) ? 'statement' : 'missing',
    total_debits_kobo: totalDebits, total_credits_kobo: totalCredits,
    lines: out.map(({ n, _col, ...rest }) => rest),
    integrity: { balances_available: haveBalances, chain_breaks: chainBreaks, totals_ok: totalsOk, ok: problems.length === 0, problems },
    warnings,
  };
}

// ── Excel / CSV rows ────────────────────────────────────────────────────────────────────────────────────────────────────────

const ROLE_PATTERNS = [
  ['value_date', /^(value\s*date|val\.?\s*date)$/i],
  ['date', /^(trans(?:action)?\.?\s*date|post(?:ing|ed)?\s*date|txn\.?\s*date|date)$/i],
  ['description', /^(narration|description|details|particulars|remarks?|transaction\s*(?:details|description)|reference)$/i],
  ['debit', /^(debits?|withdrawals?|money\s*out|paid\s*out|dr)$/i],
  ['credit', /^(credits?|deposits?|money\s*in|paid\s*in|cr)$/i],
  ['balance', /^(running\s*)?balance$/i],
  ['amount', /^(amount|value)$/i],
  ['type', /^(type|dr\s*\/\s*cr|cr\s*\/\s*dr|txn\s*type|transaction\s*type)$/i],
];
const roleOf = text => { const t = String(text == null ? '' : text).trim().replace(/\s*\(.*?\)\s*$/, '').replace(/[₦#:]/g, '').trim(); for (const [r, re] of ROLE_PATTERNS) if (re.test(t)) return r; return null; };

function parseTableRows(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new StatementParseError('The file is empty.');
  const grid = rows.map(r => (Array.isArray(r) ? r : []).map(c => (c == null ? '' : c)));
  // find the heading row: needs a date column and at least one money column
  let h = -1, cols = null;
  for (let i = 0; i < Math.min(grid.length, 60); i++) {
    const map = {};
    grid[i].forEach((c, j) => { const r = roleOf(c); if (r && map[r] == null) map[r] = j; });
    if (map.date != null && (map.amount != null || map.debit != null || map.credit != null)) { h = i; cols = map; break; }
  }
  if (h < 0) throw new StatementParseError('Could not find the column headings. The file needs a Date column and either Debit and Credit columns or an Amount column (a Description and a Balance column help).');

  const meta = metaFromText(grid.slice(0, h).map(r => r.filter(c => String(c).trim() !== '').join('  ')).join('\n'));
  const lines = []; const footer = {}; let opening = null; let skippedNoDate = 0;
  for (let i = h + 1; i < grid.length; i++) {
    const r = grid[i];
    if (r.every(c => String(c).trim() === '')) continue;
    const first = String(r.find(c => String(c).trim() !== '') ?? '').trim();
    // a repeated heading row
    if (roleOf(r[cols.date]) === 'date' && String(r[cols.date]).trim().length < 20 && parseDate(r[cols.date]) == null) continue;
    const desc = cols.description != null ? String(r[cols.description] ?? '').trim() : '';
    const money = k => (cols[k] != null ? parseMoneyToKobo(r[cols[k]]) : null);
    const date = parseDate(r[cols.date]);

    const label = FOOTER_LABELS.find(([re]) => re.test(first) || re.test(desc));
    if (label && !date) {
      const nums = r.map(parseMoneyToKobo).filter(x => x != null);
      if (nums.length) footer[label[1]] = Math.abs(nums[nums.length - 1]);
      continue;
    }
    if (OPENING_RE.test(desc || first)) {
      const b = money('balance'); const nums = r.map(parseMoneyToKobo).filter(x => x != null);
      opening = b != null ? b : (nums.length ? nums[nums.length - 1] : null);
      continue;
    }
    if (!date) { if (r.some(c => looksLikeAmount(c))) skippedNoDate++; continue; }

    const line = { date, valueDate: cols.value_date != null ? parseDate(r[cols.value_date]) : null, description: desc, balance: money('balance'), n: i + 1 };
    if (cols.debit != null || cols.credit != null) { line.debit = money('debit') ; line.credit = money('credit'); if (line.debit != null) line.debit = Math.abs(line.debit); if (line.credit != null) line.credit = Math.abs(line.credit); if (line.debit == null && line.credit == null) continue; }
    else {
      const a = money('amount'); if (a == null) continue;
      line.signed = a;
      if (cols.type != null) {
        const t = String(r[cols.type] ?? '').trim().toLowerCase();
        if (/^(credit|cr|in|deposit|c)$/.test(t)) line.direction = 'credit'; else if (/^(debit|dr|out|withdrawal|d)$/.test(t)) line.direction = 'debit';
      }
    }
    lines.push(line);
  }
  if (skippedNoDate) meta._skipped_without_date = skippedNoDate;
  const res = assemble({ meta, opening, footer, lines });
  if (skippedNoDate) res.warnings.push(`${skippedNoDate} row(s) with an amount but no date were ignored.`);
  delete res.meta._skipped_without_date;
  return res;
}

// ── PDF ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const Y_TOLERANCE = 2.6;
const STOP_ROW = /computer\s*generated|^page\s+\d+|\bpage\s+\d+\s*(?:of\s*\d+)?$|report any discrepancy/i;

/** Group a page's text items into visual rows (top to bottom), each a left-to-right list of cells { s, x, xr }. */
function rowsOfPage(items) {
  const clean = items.filter(i => i && typeof i.str === 'string').map(i => ({ str: i.str, x: i.x, y: i.y, w: i.w || 0 }));
  clean.sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  for (const it of clean) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.y - it.y) <= Y_TOLERANCE) last.items.push(it); else rows.push({ y: it.y, items: [it] });
  }
  return rows.map(r => {
    const its = r.items.sort((a, b) => a.x - b.x);
    const cells = [];
    for (const it of its) {
      if (!it.str.trim()) { cells.push(null); continue; }      // whitespace is a column gap
      const prev = cells[cells.length - 1];
      if (prev && it.x - prev.xr < 1.5 && !/^\s/.test(it.str) === true && prev.s !== '') { prev.s += it.str; prev.xr = it.x + it.w; }
      else cells.push({ s: it.str.trim(), x: it.x, xr: it.x + it.w });
    }
    return { y: r.y, cells: cells.filter(Boolean) };
  }).filter(r => r.cells.length);
}

function detectHeader(row) {
  const roles = {};
  for (const c of row.cells) { const r = roleOf(c.s); if (r && roles[r] == null) roles[r] = c; }
  const money = (roles.debit ? 1 : 0) + (roles.credit ? 1 : 0) + (roles.amount ? 1 : 0);
  if (roles.date && money >= 1 && (roles.debit || roles.credit || roles.amount)) return roles;
  return null;
}

function parsePdfPages(pages) {
  if (!Array.isArray(pages) || !pages.length) throw new StatementParseError('The PDF has no pages.');
  const allRows = pages.map(p => rowsOfPage(p.items || []));
  const textFound = allRows.some(r => r.length);
  if (!textFound) throw new StatementParseError('This PDF has no selectable text (it looks like a scan or a photo). Please download the Excel or CSV version of the statement from your bank instead.');

  const metaText = allRows[0].slice(0, 14).map(r => r.cells.map(c => c.s).join('   ')).join('\n');
  const meta = metaFromText(metaText);
  const bank = allRows[0].length ? allRows[0][0].cells.map(c => c.s).join(' ') : null;
  if (bank && !/account|statement|period/i.test(bank)) meta.bank_name = bank;

  let anchors = null;           // the column positions, remembered across pages in case a page does not repeat the heading
  const lines = []; const footer = {}; let opening = null; let cur = null; let lineNo = 0;

  for (const rows of allRows) {
    let inTable = false;
    for (const row of rows) {
      const hdr = detectHeader(row);
      if (hdr) { anchors = hdr; inTable = true; cur = null; continue; }
      if (!inTable && !anchors) continue;
      inTable = true;
      const text = row.cells.map(c => c.s).join(' ');
      if (STOP_ROW.test(text)) { cur = null; continue; }

      const first = row.cells[0];
      const dateOfFirst = parseDate(first.s);
      const lab = FOOTER_LABELS.find(([re]) => re.test(text));
      if (lab && dateOfFirst == null) {
        const nums = row.cells.filter(c => looksLikeAmount(c.s));
        if (nums.length) footer[lab[1]] = Math.abs(parseMoneyToKobo(nums[nums.length - 1].s));
        cur = null; continue;
      }

      if (dateOfFirst != null) {
        lineNo++;
        const dates = []; const nums = []; const words = [];
        for (const c of row.cells) {
          if (parseDate(c.s) != null && dates.length < 2 && words.length === 0) dates.push(parseDate(c.s));
          else if (looksLikeAmount(c.s) && (!anchors.description || c.x > anchors.description.x + 20) && /[.,]/.test(c.s)) nums.push(c);
          else words.push(c);
        }
        const description = words.map(c => c.s).join(' ');
        const rec = { date: dates[0], valueDate: dates[1] || null, description, n: lineNo };
        if (OPENING_RE.test(description)) {
          const bal = nums.length ? parseMoneyToKobo(nums[nums.length - 1].s) : null;
          if (bal != null) { opening = bal; cur = null; lineNo--; continue; }
        }
        // put each figure in the column whose right-hand edge it lines up with
        for (const c of nums) {
          const k = nearestColumn(c, anchors);
          if (!k) continue;
          const v = parseMoneyToKobo(c.s);
          if (k === 'debit') rec.debit = Math.abs(v); else if (k === 'credit') rec.credit = Math.abs(v); else if (k === 'balance') rec.balance = v; else if (k === 'amount') rec.signed = v;
        }
        // headings without a balance column: the last figure on the row can still be a balance
        lines.push(rec); cur = rec;
      } else if (cur && row.cells.every(c => !looksLikeAmount(c.s) || !/[.,]/.test(c.s))) {
        cur.description = (cur.description + ' ' + text).trim();          // the narration wrapped onto a second line
      }
    }
    cur = null;
  }
  return assemble({ meta, opening, footer, lines });
}

function nearestColumn(cell, anchors) {
  let best = null, bestD = Infinity;
  for (const k of ['debit', 'credit', 'balance', 'amount']) {
    const a = anchors[k]; if (!a) continue;
    const d = Math.abs(cell.xr - a.xr);
    if (d < bestD) { bestD = d; best = k; }
  }
  return bestD <= 45 ? best : null;
}

// ── reading the PDF itself ──────────────────────────────────────────────────────────────────────────────────────────────────

const MAX_PDF_BYTES = 4 * 1024 * 1024; // the function request body limit is ~6 MB once base64 encoded
const MAX_PDF_PAGES = 250;

/** Text items (with positions) for every page of a PDF. */
async function extractPdfPages(buffer) {
  if (!buffer || !buffer.length) throw new StatementParseError('The PDF is empty.');
  if (buffer.length > MAX_PDF_BYTES) throw new StatementParseError('This PDF is larger than 4 MB. Export a shorter period, or use the Excel / CSV version.');
  if (buffer.slice(0, 5).toString('latin1') !== '%PDF-') throw new StatementParseError('That file is not a PDF.');
  const log = console.log; const warn = console.warn;
  let pdfjs;
  try { console.log = () => {}; console.warn = () => {}; pdfjs = require('pdfjs-dist/legacy/build/pdf.js'); } finally { console.log = log; console.warn = warn; }
  let doc;
  try {
    console.log = () => {}; console.warn = () => {};
    // isEvalSupported:false closes the font-evaluation hole in older pdf.js releases; a statement never needs it.
    doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 }).promise;
  } catch (e) {
    if (/password/i.test(String(e && e.message))) throw new StatementParseError('This PDF is password protected. Remove the password (or download an unprotected copy) and try again.');
    throw new StatementParseError('This PDF could not be read. Try downloading it from your bank again, or use the Excel / CSV version.');
  } finally { console.log = log; console.warn = warn; }
  if (doc.numPages > MAX_PDF_PAGES) throw new StatementParseError(`This PDF has ${doc.numPages} pages. Export a shorter period (the limit is ${MAX_PDF_PAGES} pages).`);
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const tc = await page.getTextContent();
    pages.push({ items: tc.items.map(i => ({ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width })) });
  }
  try { await doc.destroy(); } catch (e) { /* nothing to do */ }
  return pages;
}

async function parsePdfBuffer(buffer) { return parsePdfPages(await extractPdfPages(buffer)); }

module.exports = {
  StatementParseError, parseDate, parseMoneyToKobo, looksLikeAmount, metaFromText,
  assemble, parseTableRows, rowsOfPage, parsePdfPages, extractPdfPages, parsePdfBuffer,
};
