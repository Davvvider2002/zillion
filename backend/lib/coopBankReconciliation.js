/**
 * zillion/backend/lib/coopBankReconciliation.js
 *
 * Manual bank-statement reconciliation — Zillion has no direct
 * banking API access, so a society admin uploads their real bank
 * statement (CSV) periodically, and this cross-references it against
 * what's actually recorded (loan disbursements and repayments) to
 * surface real discrepancies: a bank line with no matching record
 * (possibly unrecorded), or a recorded transaction with no matching
 * bank line (possibly never actually happened, or recorded wrong).
 *
 * Matching rule: exact amount match, date within a tolerance window
 * (bank processing/clearing can genuinely lag a few days from when a
 * transaction was recorded). Deliberately conservative — an exact
 * amount match is required, not a fuzzy one, since silently matching
 * two different amounts would defeat the entire point of this tool.
 * Tested against real scenarios (exact match, wrong amount, outside
 * the date window) before being wired into anything.
 *
 * FLUTTERWAVE: money Flutterwave settles into the society's bank (and payouts Zillion makes to it) are bank deposits that
 * exist in the books as Flutterwave ledger entries. Without them here, every genuine settlement on a bank statement would be
 * reported as "a bank line with no matching record". They are added as candidates - but ONLY when the statement is for the
 * society's settlement bank account, only as money IN, matched on the amount that actually reached the bank (net of any fee
 * Flutterwave deducted), and a settlement reference in the bank's description wins ties between same-amount candidates.
 */
'use strict';
const { fetchAllRows } = require('./coopPaginate');

const DATE_TOLERANCE_DAYS = 3;
const shiftDay = (d, n) => new Date(new Date(String(d).slice(0, 10) + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);

// Words too generic to say anything about WHICH transaction a bank line is
const GENERIC_WORDS = new Set(['PAYMENT', 'TRANSFER', 'FROM', 'LOAN', 'BANK', 'CREDIT', 'DEBIT', 'INWARD', 'OUTWARD', 'CHARGE', 'CHARGES', 'FEES', 'NAIRA', 'SAVINGS', 'DEPOSIT', 'SOCIETY', 'ACCOUNT', 'ENTRY']);
const words = s => new Set(String(s || '').toUpperCase().split(/[^A-Z0-9]+/).filter(w => w.length >= 4 && !GENERIC_WORDS.has(w)));
/** How many meaningful words the bank's description shares with ours - a tie-breaker between candidates of the same amount, never a match on its own. */
function sharedWords(a, b) { const A = words(a); let n = 0; for (const w of words(b)) if (A.has(w)) n++; return n; }

function daysBetween(a, b) {
  return Math.abs((new Date(a) - new Date(b)) / 86400000);
}

/**
 * @param {object} db  Supabase client
 * @param {string} coopId
 * @returns {Promise<Array<{type, id, amountKobo, date, description}>>}
 */
async function fetchReconcilableRecords(db, coopId, { flutterwave = null, books = null } = {}) {
  const records = [];

  const loans = await fetchAllRows(() => db.from('coop_loans')
    .select('id, principal_kobo, disbursed_at, member_id, coop_members!coop_loans_member_id_fkey(name)')
    .eq('coop_id', coopId).not('disbursed_at', 'is', null).order('id'));
  for (const l of (loans || [])) {
    records.push({
      type: 'loan_disbursement', id: l.id, amountKobo: l.principal_kobo,
      date: l.disbursed_at.slice(0, 10),
      description: `Loan disbursed to ${l.coop_members?.name || 'member'}`,
    });
  }

  const repayments = await fetchAllRows(() => db.from('coop_loan_repayments')
    .select('id, amount_kobo, recorded_at, source, loan_id, coop_loans!inner(coop_id, member_id, coop_members!coop_loans_member_id_fkey(name))')
    .eq('coop_loans.coop_id', coopId).in('source', ['cash_in_person', 'bank_transfer_manual']).order('id'));
  for (const r of (repayments || [])) {
    records.push({
      type: 'loan_repayment', id: r.id, amountKobo: r.amount_kobo,
      date: r.recorded_at.slice(0, 10),
      description: `Loan repayment from ${r.coop_loans?.coop_members?.name || 'member'}`,
    });
  }

  const loanRecords = records.slice();
  if (flutterwave) records.push(...await fetchFlutterwaveCandidates(db, coopId, flutterwave));
  if (books) records.push(...await fetchBookCandidates(db, coopId, books, loanRecords));
  return records;
}

/**
 * EVERYTHING the books record on this bank account in the statement's window - deposits, cash banked, expenses paid, transfers,
 * anything - so a statement line is not called "unexplained" just because it was not a loan or a Flutterwave settlement.
 * Only offered when accounting is set up for the society. Two kinds of entry are deliberately NOT offered, because something else
 * already represents them and offering both would leave a phantom "not on the statement" behind:
 *   - entries the Flutterwave ledger booked (linked by id, so exact): Flutterwave candidates stand for them;
 *   - an entry that duplicates a loan record (same amount, same direction, within the date tolerance): the loan record stands for it.
 * Each candidate is one journal LINE (an entry can touch the account twice), identified by that line's id.
 */
async function fetchBookCandidates(db, coopId, { accountCode, from, to }, loanCandidates = []) {
  if (!db || typeof db.rpc !== 'function') return [];
  const { data, error } = await db.rpc('coop_account_movements', { p_coop_id: coopId, p_account_code: accountCode, p_from: shiftDay(from, -(DATE_TOLERANCE_DAYS + 1)), p_to: shiftDay(to, DATE_TOLERANCE_DAYS + 1) });
  if (error) { console.error('[coopBankReconciliation] book movements unavailable, matching loans and Flutterwave only:', error.message); return []; }
  const reportUntil = shiftDay(to, -DATE_TOLERANCE_DAYS);
  const remaining = (data || []).filter(r => !r.flw_linked && Number(r.amount_kobo) > 0).map(r => {
    const date = String(r.entry_date).slice(0, 10);
    return { type: 'journal_entry', id: r.line_id, entryId: r.entry_id, entryNumber: r.entry_number, amountKobo: Number(r.amount_kobo), date,
      direction: r.line_type === 'debit' ? 'credit' : 'debit',           // money INTO an asset account is a "credit" on the bank's statement
      description: `#${r.entry_number} ${r.description || ''}`.trim(), reportable: date >= from && date <= reportUntil };
  });
  for (const loan of loanCandidates) {
    const direction = loan.type === 'loan_repayment' ? 'credit' : 'debit';
    let best = -1, bestDiff = Infinity;
    remaining.forEach((c, i) => { const diff = daysBetween(c.date, loan.date); if (c.amountKobo === loan.amountKobo && c.direction === direction && diff <= DATE_TOLERANCE_DAYS && diff < bestDiff) { best = i; bestDiff = diff; } });
    if (best >= 0) remaining.splice(best, 1);
  }
  return remaining;
}

/**
 * Flutterwave settlements and Zillion payouts into the society's bank, for a statement covering `from`..`to` (YYYY-MM-DD).
 * Matching may reach a few days either side of the statement; but a deposit is only REPORTED as missing from the statement if it
 * should definitely be on it (dated within the statement, and early enough that the bank has had time to credit it).
 */
async function fetchFlutterwaveCandidates(db, coopId, { from, to }) {
  const shift = shiftDay;
  const rows = await fetchAllRows(() => db.from('coop_flutterwave_ledger')
    .select('id, amount_kobo, fees_kobo, occurred_at, flw_settlement_id, purpose')
    .eq('coop_id', coopId).eq('entry_type', 'SETTLEMENT').eq('direction', 'OUT').eq('live_mode', true)
    .gte('occurred_at', shift(from, -(DATE_TOLERANCE_DAYS + 1)) + 'T00:00:00Z').lte('occurred_at', shift(to, DATE_TOLERANCE_DAYS + 1) + 'T23:59:59Z').order('id'));
  const reportUntil = shift(to, -DATE_TOLERANCE_DAYS);
  return (rows || []).map(r => {
    const date = String(r.occurred_at).slice(0, 10);
    return {
      type: 'flutterwave_settlement', id: r.id, direction: 'credit', ref: r.flw_settlement_id,
      amountKobo: r.amount_kobo - (r.fees_kobo || 0),                      // what actually reached the bank
      date, reportable: date >= from && date <= reportUntil,
      description: `${r.purpose === 'zillion_payout' ? 'Zillion payout' : 'Flutterwave settlement'} ${r.flw_settlement_id}`,
    };
  });
}

/**
 * @param {Array<{date, amountKobo, description}>} statementLines  parsed from the uploaded CSV
 * @param {Array} candidates  from fetchReconcilableRecords
 */
function matchStatementLines(statementLines, candidates) {
  const usedCandidateKeys = new Set();
  const matchedLines = [];
  const unmatchedLines = [];

  for (const line of statementLines) {
    let best = null;
    let bestScore = Infinity;
    for (const c of candidates) {
      const key = `${c.type}:${c.id}`;
      if (usedCandidateKeys.has(key)) continue; // each record matches at most one statement line
      if (c.amountKobo !== line.amountKobo) continue;
      if (c.direction && line.direction !== c.direction) continue;   // a settlement is money IN: it can never explain money OUT of the same amount
      const days = daysBetween(line.date, c.date);
      const refHit = !!(c.ref && line.description && String(line.description).toUpperCase().includes(String(c.ref).toUpperCase()));   // the bank quoted our reference: that is the one
      if (!refHit && days > DATE_TOLERANCE_DAYS) continue;            // exact amount AND close in time are both required (a reference may stretch the time)
      // closest date wins; each meaningful word the bank's description shares with ours is worth a day (up to three) when choosing BETWEEN
      // same-amount candidates; a reference beats everything. None of this can make a match: amount, direction and the 3-day window gate first.
      const score = days - (refHit ? 100 : 0) - Math.min(sharedWords(line.description, c.description), 3);
      if (score < bestScore) { best = c; bestScore = score; }
    }
    if (best) {
      usedCandidateKeys.add(`${best.type}:${best.id}`);
      // direction is authoritative from the match itself - a loan
      // disbursement is always money leaving the bank account, a
      // repayment always money arriving - overriding whatever the CSV
      // said, since the match proves what genuinely happened.
      const direction = best.direction || (best.type === 'loan_repayment' ? 'credit' : 'debit');
      matchedLines.push({ ...line, matched_type: best.type, matched_id: best.id, match_status: 'matched', direction });
    } else {
      unmatchedLines.push({ ...line, matched_type: null, matched_id: null, match_status: 'unmatched' });
    }
  }

  const unmatchedRecords = candidates.filter(c => !usedCandidateKeys.has(`${c.type}:${c.id}`) && c.reportable !== false);

  return { matchedLines, unmatchedLines, unmatchedRecords };
}

module.exports = { fetchReconcilableRecords, fetchFlutterwaveCandidates, fetchBookCandidates, sharedWords, matchStatementLines, DATE_TOLERANCE_DAYS };
