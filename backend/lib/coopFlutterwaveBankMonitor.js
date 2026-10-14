/**
 * zillion/backend/lib/coopFlutterwaveBankMonitor.js
 *
 * Watching the society's BANK ACCOUNT - the real account Flutterwave pays into - rather than Flutterwave itself.
 * The Flutterwave ledger says what Flutterwave holds and what it has paid out. This answers the bank-side questions:
 *
 *   1. WHICH account is it?   The real bank details (bank, number, name) beside the books account they map to.
 *   2. WHAT moved?            Opening balance, money in, money out, closing balance for that account in the books, with the
 *                             money in split into Flutterwave settlements, Zillion payouts and everything else.
 *   3. DID IT ARRIVE?         Each Flutterwave settlement/payout is checked against the bank statements the society has uploaded:
 *                               CONFIRMED                 - it is on a statement
 *                               MISSING_FROM_STATEMENT    - an uploaded statement covers that date and it is NOT on it (the alarm)
 *                               NOT_ON_A_STATEMENT_YET    - no uploaded statement reaches that date, so nothing can be said yet
 *   4. WAS IT BOOKED RIGHT?   Each settlement must have been booked to the SELECTED bank account (not a different one).
 *   5. IS ANYTHING UNEXPLAINED?  Bank-statement credits that look like Flutterwave/Zillion money but match nothing in the ledger.
 *
 * It never decides a statement is wrong on thin evidence: a payout is only reported missing when an uploaded statement genuinely
 * spans its date (allowing for the bank's few days of processing).
 */
'use strict';

const { fetchAllRows, chunk } = require('./coopPaginate');
const { describeSettlementAccount, settlementAccountCode, isSettlementAccount, bankAccountLabel } = require('./coopBankAccountInfo');
const { DATE_TOLERANCE_DAYS } = require('./coopBankReconciliation');
const { isLiveMode, STALE_HELD_DAYS } = require('./coopFlutterwaveLedger');

const STATEMENT_STALE_DAYS = 35;
const LOOKS_LIKE_FLUTTERWAVE = /FLW|FLUTTERWAVE|RAVE\b|ZILLION/i;
const BANK_CHARGES_CODE = '5200';

const day = d => new Date(d).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(new Date(day(d) + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);

async function rpc(db, fn, args) {
  if (!db || typeof db.rpc !== 'function') return null;
  const { data, error } = await db.rpc(fn, args);
  return error ? null : data;
}

/** @param {object} opts { from, to (YYYY-MM-DD), accountCode, now } */
async function buildBankMonitor(db, coopId, { from, to, accountCode, now = new Date() } = {}) {
  const toDay = to || day(now), fromDay = from || addDays(toDay, -90);

  const { data: society } = await db.from('coop_societies').select('coop_id, name, flutterwave_subaccount_id, settlement_account_code, settlement_account_number, settlement_bank_code, settlement_account_name').eq('coop_id', coopId).maybeSingle();
  const coa = await fetchAllRows(() => db.from('coop_chart_of_accounts').select('id, account_code, account_name, account_type, sub_type, active').eq('coop_id', coopId).order('id'));
  const byId = new Map(coa.map(a => [a.id, a]));
  const bankAccounts = coa.filter(a => a.sub_type === 'bank_cash' && a.active !== false);
  const code = accountCode || settlementAccountCode(society);
  const account = coa.find(a => a.account_code === code);
  const isFlw = isSettlementAccount(society, code);

  const identification = {
    code, name: account ? account.account_name : null, found: !!account, is_flutterwave_settlement_account: isFlw,
    selected_explicitly: !!(society && society.settlement_account_code),
    bank: isFlw ? describeSettlementAccount(society) : null,
    options: bankAccounts.map(a => ({ code: a.account_code, name: a.account_name, label: bankAccountLabel(society, a), is_flutterwave_settlement_account: isSettlementAccount(society, a.account_code) })),
  };

  // 1. what moved through the account, in the books (added up by the database)
  const gl = await rpc(db, 'coop_account_period_totals', { p_coop_id: coopId, p_account_code: code, p_from: fromDay, p_to: toDay });

  // 2. the Flutterwave money paid into it, with the journal entry that booked each
  let inflows = [];
  if (isFlw) {
    const rows = await fetchAllRows(() => db.from('coop_flutterwave_ledger')
      .select('id, amount_kobo, fees_kobo, occurred_at, flw_settlement_id, purpose, journal_entry_id, match_status, account_matches')
      .eq('coop_id', coopId).eq('entry_type', 'SETTLEMENT').eq('direction', 'OUT').eq('live_mode', true)
      .gte('occurred_at', addDays(fromDay, -DATE_TOLERANCE_DAYS) + 'T00:00:00Z').lte('occurred_at', toDay + 'T23:59:59Z').order('occurred_at').order('id'));
    const linesByEntry = new Map(), dateByEntry = new Map();
    for (const ids of chunk(rows.map(r => r.journal_entry_id).filter(Boolean))) {
      for (const l of await fetchAllRows(() => db.from('coop_journal_entry_lines').select('journal_entry_id, account_id, line_type, amount').in('journal_entry_id', ids).order('id'))) {
        if (!linesByEntry.has(l.journal_entry_id)) linesByEntry.set(l.journal_entry_id, []); linesByEntry.get(l.journal_entry_id).push(l);
      }
      for (const e of await fetchAllRows(() => db.from('coop_journal_entries').select('id, entry_date').in('id', ids).order('id'))) dateByEntry.set(e.id, e.entry_date);
    }
    inflows = rows.filter(r => day(r.occurred_at) >= fromDay).map(r => {
      const debits = (linesByEntry.get(r.journal_entry_id) || []).filter(l => String(l.line_type).toLowerCase() === 'debit').map(l => (byId.get(l.account_id) || {}).account_code).filter(c => c && c !== BANK_CHARGES_CODE);
      return { ...r, bank_amount_kobo: r.amount_kobo - (r.fees_kobo || 0), posted_to: debits[0] || null, booked_on: dateByEntry.get(r.journal_entry_id) || null };
    });
  }

  // 2b. the whole remittance chain, not just the last hop: what members paid through Flutterwave, what it kept as fees, what has reached
  //     the bank, and what Flutterwave is still holding. Test-mode money is kept apart: Flutterwave never settles it, so it can never reach a bank.
  const payments = await fetchAllRows(() => db.from('coop_flutterwave_ledger')
    .select('id, amount_kobo, gross_kobo, fees_kobo, live_mode, settled_in, channel, occurred_at')
    .eq('coop_id', coopId).eq('entry_type', 'PAYMENT')
    .gte('occurred_at', fromDay + 'T00:00:00Z').lte('occurred_at', toDay + 'T23:59:59Z').order('occurred_at').order('id'));
  const livePay = payments.filter(r => r.live_mode), testPay = payments.filter(r => !r.live_mode);
  const sum = (rows, f) => rows.reduce((t, r) => t + (Number(f(r)) || 0), 0);
  const heldRows = livePay.filter(r => !r.settled_in && r.channel !== 'virtual_account');
  const owedRows = livePay.filter(r => !r.settled_in && r.channel === 'virtual_account');
  const clearing = await rpc(db, 'coop_clearing_totals', { p_coop_id: coopId });
  const testSettlementRows = isFlw ? await fetchAllRows(() => db.from('coop_flutterwave_ledger').select('id, amount_kobo, journal_entry_id, occurred_at')
    .eq('coop_id', coopId).eq('entry_type', 'SETTLEMENT').eq('direction', 'OUT').eq('live_mode', false)
    .gte('occurred_at', fromDay + 'T00:00:00Z').lte('occurred_at', toDay + 'T23:59:59Z').order('id')) : [];
  const pipeline = {
    live_key: isLiveMode(), has_subaccount: !!(society && society.flutterwave_subaccount_id),
    collected_kobo: sum(livePay, r => r.gross_kobo != null ? r.gross_kobo : r.amount_kobo), credited_to_society_kobo: sum(livePay, r => r.amount_kobo),
    fees_kobo: sum(livePay, r => r.fees_kobo), payments_count: livePay.length,
    held_kobo: sum(heldRows, r => r.amount_kobo), held_count: heldRows.length,
    oldest_held_days: heldRows.length ? Math.floor((now - new Date(heldRows.reduce((m, r) => (r.occurred_at < m ? r.occurred_at : m), heldRows[0].occurred_at))) / 86400000) : 0,
    owed_by_zillion_kobo: sum(owedRows, r => r.amount_kobo), owed_by_zillion_count: owedRows.length,
    clearing_balance_kobo: clearing ? clearing.debit_kobo - clearing.credit_kobo : null,
    test_payments_count: testPay.length, test_payments_kobo: sum(testPay, r => r.amount_kobo), test_settlements_kobo: sum(testSettlementRows, r => r.amount_kobo),
  };

  // 3. which statements exist, and which Flutterwave deposits are on them
  const coverage = account ? (await rpc(db, 'coop_bank_statement_coverage', { p_coop_id: coopId, p_bank_account_id: account.id })) || [] : [];
  const batchIds = coverage.map(b => b.batch_id);
  const confirmed = new Set(); let suspects = [];
  for (const ids of chunk(batchIds)) {
    for (const l of await fetchAllRows(() => db.from('coop_bank_statement_lines').select('matched_id').in('batch_id', ids).eq('matched_type', 'flutterwave_settlement').order('id'))) confirmed.add(l.matched_id);
    const unmatched = await fetchAllRows(() => db.from('coop_bank_statement_lines').select('id, statement_date, description, amount_kobo, batch_id')
      .in('batch_id', ids).eq('match_status', 'unmatched').eq('direction', 'credit').gte('statement_date', addDays(fromDay, -DATE_TOLERANCE_DAYS)).lte('statement_date', toDay).order('id'));
    suspects.push(...unmatched.filter(l => LOOKS_LIKE_FLUTTERWAVE.test(l.description || '')));
  }
  const covered = d => coverage.some(b => b.from_date <= d && addDays(d, DATE_TOLERANCE_DAYS) <= b.to_date);
  const flwInflows = inflows.map(r => {
    const d = day(r.occurred_at);
    const status = confirmed.has(r.id) ? 'CONFIRMED' : (covered(d) ? 'MISSING_FROM_STATEMENT' : 'NOT_ON_A_STATEMENT_YET');
    return { id: r.id, date: d, reference: r.flw_settlement_id, source: r.purpose === 'zillion_payout' ? 'Zillion payout' : 'Flutterwave settlement', bank_amount_kobo: r.bank_amount_kobo, fees_kobo: r.fees_kobo || 0,
      booked_to_account: r.posted_to, booked_to_selected_account: r.posted_to === code, booked_on: r.booked_on, statement_status: status, match_status: r.match_status };
  });

  // 4. the movement, split by where the money came from
  const inBooks = flwInflows.filter(r => r.booked_to_selected_account && r.booked_on && r.booked_on >= fromDay && r.booked_on <= toDay);
  const settlementsKobo = inBooks.filter(r => r.source === 'Flutterwave settlement').reduce((t, r) => t + r.bank_amount_kobo, 0);
  const payoutsKobo = inBooks.filter(r => r.source === 'Zillion payout').reduce((t, r) => t + r.bank_amount_kobo, 0);
  const testSettledKobo = Math.min(pipeline.test_settlements_kobo, gl ? gl.inflow_kobo - settlementsKobo - payoutsKobo : 0);
  const movement = gl ? {
    opening_kobo: gl.opening_kobo, inflow_kobo: gl.inflow_kobo, outflow_kobo: gl.outflow_kobo, closing_kobo: gl.closing_kobo,
    inflow_flutterwave_settlements_kobo: settlementsKobo, inflow_zillion_payouts_kobo: payoutsKobo, inflow_test_settlements_kobo: Math.max(0, testSettledKobo), inflow_other_kobo: Math.max(0, gl.inflow_kobo - settlementsKobo - payoutsKobo - Math.max(0, testSettledKobo)),
  } : null;

  // 5. the latest statement against the books
  const latest = coverage[0] || null;
  let lastStatement = null;
  if (latest) {
    const booksAt = await rpc(db, 'coop_account_period_totals', { p_coop_id: coopId, p_account_code: code, p_from: latest.to_date, p_to: latest.to_date });
    lastStatement = { batch_id: latest.batch_id, filename: latest.filename, uploaded_at: latest.uploaded_at, covers_from: latest.from_date, covers_to: latest.to_date, lines: latest.lines,
      statement_closing_kobo: latest.closing_balance_kobo, books_balance_at_that_date_kobo: booksAt ? booksAt.closing_kobo : null,
      difference_kobo: (latest.closing_balance_kobo != null && booksAt) ? latest.closing_balance_kobo - booksAt.closing_kobo : null };
  }
  const newestCovered = coverage.reduce((m, b) => (b.to_date > m ? b.to_date : m), '');

  // the checks
  const missing = flwInflows.filter(r => r.statement_status === 'MISSING_FROM_STATEMENT');
  const elsewhere = flwInflows.filter(r => !r.booked_to_selected_account);
  const naira = k => '₦' + (k / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const checks = [];
  checks.push({ key: 'bank_identified', label: 'The bank account Flutterwave pays into is identified',
    ok: isFlw ? (identification.bank.configured && identification.selected_explicitly) : null,
    detail: !isFlw ? `Showing ${code}, which is not the Flutterwave settlement account` : !identification.bank.configured ? 'No settlement bank details are on file for this society' : !identification.selected_explicitly ? `Defaulting to ${code}. Confirm in Accounting which of your bank accounts Flutterwave pays into.` : null });
  if (isFlw) {
    checks.push({ key: 'booked_to_account', label: 'Every Flutterwave settlement was booked to this bank account', ok: elsewhere.length === 0,
      detail: elsewhere.length ? `${elsewhere.length} settlement(s) were booked to a different account (${[...new Set(elsewhere.map(r => r.booked_to_account || 'none'))].join(', ')})` : null });
    checks.push({ key: 'on_statement', label: 'Every Flutterwave settlement shows on the bank statements you have uploaded', ok: coverage.length === 0 ? null : missing.length === 0,
      detail: coverage.length === 0 ? 'No bank statement has been uploaded for this account yet' : missing.length ? `${missing.length} payout(s) are missing from a statement that covers them: ${missing.slice(0, 3).map(r => `${r.reference} (${naira(r.bank_amount_kobo)} on ${r.date})`).join('; ')}${missing.length > 3 ? ' ...' : ''}` : null });
    checks.push({ key: 'no_unexplained_deposits', label: 'No bank deposits that look like Flutterwave money are unexplained', ok: suspects.length === 0,
      detail: suspects.length ? `${suspects.length} deposit(s) on your statements look like Flutterwave/Zillion money but match nothing recorded: ${suspects.slice(0, 3).map(s => `${naira(s.amount_kobo)} on ${s.statement_date}`).join('; ')}` : null });
  }
  checks.push({ key: 'statement_current', label: `A bank statement has been reconciled in the last ${STATEMENT_STALE_DAYS} days`,
    ok: !newestCovered ? null : (now - new Date(newestCovered + 'T00:00:00Z')) / 86400000 <= STATEMENT_STALE_DAYS,
    detail: !newestCovered ? 'No statement has been uploaded for this account' : (now - new Date(newestCovered + 'T00:00:00Z')) / 86400000 > STATEMENT_STALE_DAYS ? `The newest statement on file ends ${newestCovered}` : null });

  if (isFlw) {
    checks.push({ key: 'flutterwave_live', label: 'Flutterwave is in live mode, so its payments can settle to the bank',
      ok: pipeline.live_key ? true : (pipeline.test_payments_count || pipeline.test_settlements_kobo ? false : null),
      detail: pipeline.live_key ? null : `Flutterwave is running in TEST mode. Test payments are recorded (${pipeline.test_payments_count} in this period, ${naira(pipeline.test_payments_kobo)}) but Flutterwave never settles them, so none of it can reach the bank. Real settlements only appear once live keys are in use.` });
    checks.push({ key: 'subaccount', label: 'This society has a Flutterwave sub-account to receive settlements', ok: pipeline.has_subaccount,
      detail: pipeline.has_subaccount ? null : 'No Flutterwave sub-account is set up, so settlements cannot be fetched or matched. Provision the settlement account first.' });
    checks.push({ key: 'not_held_too_long', label: `No live payment held by Flutterwave for more than ${STALE_HELD_DAYS} days`, ok: pipeline.oldest_held_days <= STALE_HELD_DAYS,
      detail: pipeline.oldest_held_days > STALE_HELD_DAYS ? `${pipeline.held_count} payment(s) worth ${naira(pipeline.held_kobo)} have not been settled (oldest ${pipeline.oldest_held_days} days). Use "Fetch settlements now"; if they still do not appear, check the settlement in your Flutterwave dashboard.` : null });
  }
  if (movement) checks.push({ key: 'bank_not_negative', label: 'The bank balance in your books is not negative', ok: movement.closing_kobo >= 0,
    detail: movement.closing_kobo < 0 ? `Your books show ${naira(movement.closing_kobo)} in this account. Money has gone out that was never recorded as coming in: ${pipeline.held_kobo ? `${naira(pipeline.held_kobo)} of member payments is still held by Flutterwave (not yet settled), and ` : ''}check that the opening balance was set and that deposits made straight to the bank were recorded.` : null });

  return {
    society: { coop_id: coopId, name: society && society.name }, from: fromDay, to: toDay, account: identification, movement, pipeline,
    flutterwave_inflows: flwInflows, unexplained_deposits: suspects.map(s => ({ date: s.statement_date, amount_kobo: s.amount_kobo, description: s.description })),
    last_statement: lastStatement, statements: coverage.map(b => ({ batch_id: b.batch_id, filename: b.filename, uploaded_at: b.uploaded_at, covers_from: b.from_date, covers_to: b.to_date, lines: b.lines })),
    checks, all_ok: checks.every(c => c.ok !== false),
  };
}

module.exports = { buildBankMonitor, STATEMENT_STALE_DAYS, LOOKS_LIKE_FLUTTERWAVE };
