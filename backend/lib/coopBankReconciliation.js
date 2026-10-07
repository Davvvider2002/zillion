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

function daysBetween(a, b) {
  return Math.abs((new Date(a) - new Date(b)) / 86400000);
}

/**
 * @param {object} db  Supabase client
 * @param {string} coopId
 * @returns {Promise<Array<{type, id, amountKobo, date, description}>>}
 */
async function fetchReconcilableRecords(db, coopId, { flutterwave = null } = {}) {
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

  if (flutterwave) records.push(...await fetchFlutterwaveCandidates(db, coopId, flutterwave));
  return records;
}

/**
 * Flutterwave settlements and Zillion payouts into the society's bank, for a statement covering `from`..`to` (YYYY-MM-DD).
 * Matching may reach a few days either side of the statement; but a deposit is only REPORTED as missing from the statement if it
 * should definitely be on it (dated within the statement, and early enough that the bank has had time to credit it).
 */
async function fetchFlutterwaveCandidates(db, coopId, { from, to }) {
  const shift = (d, n) => new Date(new Date(d + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
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
    let bestDiff = Infinity;
    for (const c of candidates) {
      const key = `${c.type}:${c.id}`;
      if (usedCandidateKeys.has(key)) continue; // each record matches at most one statement line
      if (c.amountKobo !== line.amountKobo) continue;
      if (c.direction && line.direction !== c.direction) continue;   // a settlement is money IN: it can never explain money OUT of the same amount
      let diff = daysBetween(line.date, c.date);
      if (c.ref && line.description && String(line.description).toUpperCase().includes(String(c.ref).toUpperCase())) diff = -1;   // the bank quoted our reference: that is the one
      if ((diff <= DATE_TOLERANCE_DAYS) && diff < bestDiff) { best = c; bestDiff = diff; }
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

module.exports = { fetchReconcilableRecords, fetchFlutterwaveCandidates, matchStatementLines, DATE_TOLERANCE_DAYS };
