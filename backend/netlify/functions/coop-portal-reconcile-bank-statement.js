/**
 * zillion/backend/netlify/functions/coop-portal-reconcile-bank-statement.js
 *
 * POST /api/v1/coop-portal-reconcile-bank-statement
 *
 * Accepts a parsed bank statement (parsing happens client-side, given
 * how much real-world CSV formats vary by bank — this endpoint just
 * needs { date, amount_kobo, description } per line) and runs it
 * against every recorded loan disbursement and manually-recorded
 * repayment for the society, via coopBankReconciliation.js.
 *
 * Gated behind the Bank Reconciliation add-on, same pattern as
 * Accounting.
 *
 * Body: { filename, bank_account_id, opening_balance_kobo?, closing_balance_kobo?,
 *         lines: [{ date, amount_kobo, description, direction }] }
 *
 * direction ('credit'|'debit') is required per line for the closing
 * balance to mean anything - money in vs money out has to come from
 * somewhere, and for a matched line it's overridden anyway by what
 * the match itself proves happened (see coopBankReconciliation.js).
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');
const { hasAddon }             = require('../../lib/coopEntitlements');
const { fetchReconcilableRecords, matchStatementLines } = require('../../lib/coopBankReconciliation');
const { describeSettlementAccount, isSettlementAccount, bankNameFor, maskAccount } = require('../../lib/coopBankAccountInfo');
const { accountingIsReady } = require('../../lib/coopAccountingHelpers');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');

  const db = getServiceClient();
  const resolved = await resolvePortalSociety(db, auth);
  if (!resolved.ok) return err(resolved.status, resolved.error);
  const coopId = resolved.society.coop_id;

  if (!(await requirePortalPermission(db, auth, 'reconciliation', 'create'))) {
    return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');
  }

  if (!(await hasAddon(db, coopId, 'bank_reconciliation'))) return err(403, 'Bank Reconciliation is not on your current plan');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length) return err(400, 'lines must be a non-empty array of { date, amount_kobo, description, direction }');

  const statementLines = [];
  for (const l of lines) {
    const amountKobo = Number(l.amount_kobo);
    if (!l.date || !Number.isFinite(amountKobo) || amountKobo <= 0)
      return err(400, `Invalid line: every entry needs a valid date and a positive amount_kobo. Got: ${JSON.stringify(l)}`);
    if (!['credit', 'debit'].includes(l.direction))
      return err(400, `Invalid line: direction must be "credit" or "debit". Got: ${JSON.stringify(l)}`);
    statementLines.push({ date: l.date, amountKobo, description: l.description || '', direction: l.direction });
  }

  const openingBalanceKobo = Number.isInteger(body.opening_balance_kobo) ? body.opening_balance_kobo : null;
  const closingBalanceKobo = Number.isInteger(body.closing_balance_kobo) ? body.closing_balance_kobo : null;

  if (!body.bank_account_id) return err(400, 'bank_account_id is required');
  const { data: bankAccount } = await db.from('coop_chart_of_accounts')
    .select('id, account_code, account_name, sub_type, active').eq('id', body.bank_account_id).eq('coop_id', coopId).maybeSingle();
  if (!bankAccount || !bankAccount.active) return err(400, 'That account was not found in your chart of accounts');
  if (bankAccount.sub_type !== 'bank_cash') return err(400, `"${bankAccount.account_name}" is not classified as Bank & Cash — reclassify it in Chart of Accounts first, or pick a different account`);

  // Is this statement for the account Flutterwave settles into? If so, Flutterwave settlements and Zillion payouts are expected on it
  // (and are matched), otherwise they are none of this statement's business.
  const { data: soc } = await db.from('coop_societies').select('settlement_account_code, settlement_account_number, settlement_bank_code, settlement_account_name').eq('coop_id', coopId).maybeSingle();
  const isFlwAccount = isSettlementAccount(soc, bankAccount.account_code);
  const dates = statementLines.map(l => String(l.date).slice(0, 10)).sort();
  // With accounting set up, EVERYTHING the books recorded on this bank account is a candidate - deposits, cash banked, expenses, transfers -
  // not only loans and Flutterwave. Without it there are no books to compare with, so behaviour is as it always was.
  const booksReady = await accountingIsReady(db, coopId);
  const window = { from: dates[0], to: dates[dates.length - 1] };
  const candidates = await fetchReconcilableRecords(db, coopId, { flutterwave: isFlwAccount ? window : null, books: booksReady ? { accountCode: bankAccount.account_code, ...window } : null });
  const { matchedLines, unmatchedLines, unmatchedRecords } = matchStatementLines(statementLines, candidates);
  const flwBank = describeSettlementAccount(soc);

  const { data: batch, error: batchErr } = await db.from('coop_bank_reconciliation_batches').insert({
    coop_id: coopId,
    uploaded_by: resolved.society.merchant_id,
    filename: body.filename || null,
    bank_account_id: bankAccount.id,
    // the account as the person will recognise it in the history: the books account AND, for the Flutterwave settlement account, the real bank
    bank_name: isFlwAccount && flwBank.configured ? `${bankAccount.account_name} — ${flwBank.bank_name} ${maskAccount(flwBank.account_number)}` : bankAccount.account_name,
    opening_balance_kobo: openingBalanceKobo,
    closing_balance_kobo: closingBalanceKobo,
    total_lines: statementLines.length,
    matched_lines: matchedLines.length,
  }).select().single();
  if (batchErr || !batch) return err(500, `Failed to save reconciliation batch: ${batchErr?.message}`);

  const allLines = [...matchedLines, ...unmatchedLines];
  if (allLines.length) {
    await db.from('coop_bank_statement_lines').insert(allLines.map(l => ({
      batch_id: batch.id, coop_id: coopId, statement_date: l.date, description: l.description,
      amount_kobo: l.amountKobo, matched_type: l.matched_type, matched_id: l.matched_id,
      match_status: l.match_status, direction: l.direction,
    })));
  }
  if (unmatchedRecords.length) {
    await db.from('coop_reconciliation_unmatched_records').insert(unmatchedRecords.map(r => ({
      batch_id: batch.id, coop_id: coopId, record_type: r.type, record_id: r.id,
      record_date: r.date, amount_kobo: r.amountKobo, description: r.description,
    })));
  }

  return ok({
    success: true,
    batch_id: batch.id,
    total_lines: statementLines.length,
    matched_count: matchedLines.length,
    unmatched_line_count: unmatchedLines.length,
    unmatched_record_count: unmatchedRecords.length,
    unmatched_lines: unmatchedLines,
    unmatched_records: unmatchedRecords,
    // what this means for Flutterwave money
    bank_account: { id: bankAccount.id, code: bankAccount.account_code, name: bankAccount.account_name, is_flutterwave_settlement_account: isFlwAccount, ...(isFlwAccount ? flwBank : {}) },
    books: booksReady ? {
      matched: matchedLines.filter(l => l.matched_type === 'journal_entry').length,
      not_on_statement: unmatchedRecords.filter(r => r.type === 'journal_entry').length,
    } : null,
    flutterwave: isFlwAccount ? {
      matched: matchedLines.filter(l => l.matched_type === 'flutterwave_settlement').length,
      not_on_statement: unmatchedRecords.filter(r => r.type === 'flutterwave_settlement').length,
    } : null,
  });
};
