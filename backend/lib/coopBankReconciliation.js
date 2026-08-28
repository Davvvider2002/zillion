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
 */
'use strict';

const DATE_TOLERANCE_DAYS = 3;

function daysBetween(a, b) {
  return Math.abs((new Date(a) - new Date(b)) / 86400000);
}

/**
 * @param {object} db  Supabase client
 * @param {string} coopId
 * @returns {Promise<Array<{type, id, amountKobo, date, description}>>}
 */
async function fetchReconcilableRecords(db, coopId) {
  const records = [];

  const { data: loans } = await db.from('coop_loans')
    .select('id, principal_kobo, disbursed_at, member_id, coop_members!coop_loans_member_id_fkey(name)')
    .eq('coop_id', coopId).not('disbursed_at', 'is', null);
  for (const l of (loans || [])) {
    records.push({
      type: 'loan_disbursement', id: l.id, amountKobo: l.principal_kobo,
      date: l.disbursed_at.slice(0, 10),
      description: `Loan disbursed to ${l.coop_members?.name || 'member'}`,
    });
  }

  const { data: repayments } = await db.from('coop_loan_repayments')
    .select('id, amount_kobo, recorded_at, source, loan_id, coop_loans!inner(coop_id, member_id, coop_members!coop_loans_member_id_fkey(name))')
    .eq('coop_loans.coop_id', coopId).in('source', ['cash_in_person', 'bank_transfer_manual']);
  for (const r of (repayments || [])) {
    records.push({
      type: 'loan_repayment', id: r.id, amountKobo: r.amount_kobo,
      date: r.recorded_at.slice(0, 10),
      description: `Loan repayment from ${r.coop_loans?.coop_members?.name || 'member'}`,
    });
  }

  return records;
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
      const diff = daysBetween(line.date, c.date);
      if (diff <= DATE_TOLERANCE_DAYS && diff < bestDiff) { best = c; bestDiff = diff; }
    }
    if (best) {
      usedCandidateKeys.add(`${best.type}:${best.id}`);
      matchedLines.push({ ...line, matched_type: best.type, matched_id: best.id, match_status: 'matched' });
    } else {
      unmatchedLines.push({ ...line, matched_type: null, matched_id: null, match_status: 'unmatched' });
    }
  }

  const unmatchedRecords = candidates.filter(c => !usedCandidateKeys.has(`${c.type}:${c.id}`));

  return { matchedLines, unmatchedLines, unmatchedRecords };
}

module.exports = { fetchReconcilableRecords, matchStatementLines, DATE_TOLERANCE_DAYS };
