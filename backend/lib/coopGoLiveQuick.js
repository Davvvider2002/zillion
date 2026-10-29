/**
 * zillion/backend/lib/coopGoLiveQuick.js
 *
 * Go-live "Quick start". The detailed path replays a year of dated records. Quick start takes one position as at the cutover
 * date, in three sheets, and does the double entry itself:
 *
 *   q_members   one row per member: savings, shares, dues paid to date, and (for the dividend) what was added this year.
 *   q_loans     one row per loan: terms, repaid to date, and repaid this year (interest paid this year drives the dividend).
 *   q_balances  the society's own trial balance at the cutover date, WITHOUT the member accounts. Income and expense
 *               accounts carry the year-to-date totals.
 *
 * Savings, share capital, loans receivable (principal and interest), dues receivable, dues income and loan interest income are
 * worked out here from the member and loan sheets, so a society never types the same money twice. They are posted with the
 * society's own lines as ONE balanced opening entry dated the cutover date. Whatever the lines do not balance goes to
 * Opening Balance Equity and is shown as it is.
 *
 * Member records land in the same tables live operation uses, tagged with the batch. "Held before the year" markers are dated the
 * day before the financial year start and "this year" markers inside it, so the dividend run counts them as imported history.
 */
'use strict';

const imp = require('./coopGoLiveImport');
const { fetchAllRows, chunk } = require('./coopPaginate');
const { computeSubledger } = require('./coopSubledgers');
const { computeTotalDuesAccrued } = require('./coopDues');

const { stamp, dayBefore, computeLoanTerms, LOAN_METHODS, fmtNaira, cleanText, normalisePhone, activateMember, checkMemberCapAllows,
  computeRepaymentSplit, computeReducingBalanceSplit, nextEntryNumber, ensureChartOfAccounts, hasAddon } = imp.internals;
const { parseNaira, parseFlexDay, resolveMember, deleteJournals, refreshLoanStatuses } = imp;

// Accounts the member and loan sheets produce. They must not be typed on the trial balance as well.
const AUTO_ACCOUNTS = {
  '1100': 'Loan principal outstanding comes from the loans sheet.',
  '1110': 'Loan interest outstanding comes from the loans sheet.',
  '1150': 'Dues owed come from the members sheet and the society dues rate.',
  '2000': 'Member savings come from the members sheet.',
  '3000': 'Share capital comes from the members sheet.',
  '3900': 'Opening Balance Equity is worked out for you.',
  '4100': 'Dues income for the year is worked out from the dues rate and each member\'s join date.',
  '4150': 'Loan interest income for the year is worked out from the loans sheet.',
};

const SPECS = {
  q_members: {
    title: 'Members and balances',
    columns: [
      { name: 'member_no', required: false, help: 'The society\'s own member number. Leave blank to have Zillion number them.', aliases: ['member_number', 'memberno', 'no'] },
      { name: 'name', required: true, help: 'Full name.', aliases: ['full_name', 'member_name'] },
      { name: 'phone', required: true, help: 'Mobile number. Needed to activate the member\'s wallet.', aliases: ['phone_number', 'mobile', 'mobile_number', 'tel', 'telephone'] },
      { name: 'join_date', required: true, help: 'Day the member joined, YYYY-MM-DD or DD/MM/YYYY.', aliases: ['joined', 'date_joined', 'joined_on'] },
      { name: 'status', required: false, help: 'active (default) or exited.', aliases: [] },
      { name: 'exit_date', required: false, help: 'Required when status is exited.', aliases: ['exited_on', 'date_exited'] },
      { name: 'exit_reason', required: false, help: 'Optional note.', aliases: [] },
      { name: 'postcode', required: false, help: 'Optional NIPOST digital postcode.', aliases: ['digital_postcode'] },
      { name: 'savings_balance', required: false, help: 'Naira the member has saved on the cutover date.', aliases: ['savings', 'opening_savings'] },
      { name: 'shares_balance', required: false, help: 'Naira of share capital held on the cutover date.', aliases: ['shares', 'opening_shares'] },
      { name: 'dues_paid_total', required: false, help: 'All dues the member has ever paid, up to the cutover date. Dues owed are worked out from this.', aliases: ['dues_paid', 'dues_paid_to_date', 'opening_dues_paid'] },
      { name: 'savings_added_this_year', required: false, help: 'Optional. Net naira added to savings since the financial year start. Used for the dividend.', aliases: ['savings_this_year'] },
      { name: 'shares_added_this_year', required: false, help: 'Optional. Naira of shares bought since the financial year start. Used for the dividend.', aliases: ['shares_this_year'] },
      { name: 'dues_paid_this_year', required: false, help: 'Optional. Dues paid since the financial year start. Used for the dividend.', aliases: ['dues_this_year'] },
    ],
    examples: [
      ['0001', 'Adaobi Okafor', '08031234567', '2019-05-10', 'active', '', '', '', '165000', '95000', '85000', '45000', '20000', '25000'],
      ['0002', 'Tunde Bakare', '08051234567', '2021-02-01', 'exited', '2026-04-30', 'Relocated', '', '40000', '25000', '30000', '0', '0', '5000'],
    ],
  },
  q_loans: {
    title: 'Loans and repayments',
    columns: [
      { name: 'loan_ref', required: true, help: 'Your own loan reference.', aliases: ['ref', 'loan_no', 'loan_number'] },
      { name: 'member_no', required: true, help: 'Borrower\'s member number, or phone number.', aliases: ['member', 'phone'] },
      { name: 'principal', required: true, help: 'Amount lent, naira.', aliases: ['amount'] },
      { name: 'interest_method', required: false, help: 'flat (default), reducing_emi or reducing_declining.', aliases: ['method'] },
      { name: 'interest_rate_percent', required: false, help: 'Flat: percent of principal for the whole loan. Reducing: percent per month.', aliases: ['rate', 'interest_rate'] },
      { name: 'term_months', required: true, help: 'Number of monthly repayments.', aliases: ['months', 'term'] },
      { name: 'disbursed_date', required: true, help: 'Day the money was lent.', aliases: ['date', 'disbursed_on'] },
      { name: 'repaid_to_date', required: false, help: 'Total naira repaid on this loan up to the cutover date.', aliases: ['repaid', 'total_repaid'] },
      { name: 'repaid_this_year', required: false, help: 'Part of that repaid since the financial year start. Blank means all of it for a loan lent this year, none for an older loan. Interest paid this year drives the dividend.', aliases: ['repaid_in_year'] },
    ],
    examples: [['L-2025-014', '0001', '300000', 'flat', '10', '12', '2025-11-01', '165000', '110000'], ['L-2026-003', '0002', '100000', 'reducing_emi', '2', '6', '2026-03-10', '35000', '']],
  },
  q_balances: {
    title: 'Society trial balance',
    columns: [
      { name: 'account_code', required: true, help: 'Account code from the chart of accounts. Leave out savings, shares, loans, dues and Opening Balance Equity: Zillion works those out.', aliases: ['code', 'account'] },
      { name: 'balance', required: true, help: 'Naira. Assets and liabilities: the balance on the cutover date. Income and expense: the total for the financial year to date.', aliases: ['amount'] },
      { name: 'side', required: false, help: 'debit or credit. Blank means the account\'s normal side.', aliases: ['dr_cr'] },
    ],
    examples: [['1000', '250000', ''], ['1010', '4200000', ''], ['4120', '180000', ''], ['5200', '320000', '']],
  },
};

const money = (c, f) => (c[f] === '' ? { kobo: 0 } : (k => (k == null ? { error: `${f} "${c[f]}" must be a naira figure of zero or more.` } : { kobo: k }))(parseNaira(c[f])));

// ───────────────────────────── validation ─────────────────────────────

function validateQMembers(rows, ctx) {
  // The shared member checks (names, phones, dates, numbers) run on the same row with the balance columns renamed.
  const mapped = rows.map(r => ({ line: r.line, cells: { ...r.cells, opening_savings: r.cells.savings_balance, opening_shares: r.cells.shares_balance, opening_dues_paid: r.cells.dues_paid_total } }));
  const base = imp.validate('members', mapped, ctx);
  const byLine = new Map(rows.map(r => [r.line, r.cells]));
  const valid = [], errors = base.errors.slice();
  for (const v of base.valid) {
    const c = byLine.get(v.line);
    const flows = {};
    let bad = null;
    for (const [f, key, cap, capName] of [['savings_added_this_year', 'savingsFlow', v.openingSavingsKobo, 'savings_balance'], ['shares_added_this_year', 'sharesFlow', v.openingSharesKobo, 'shares_balance'], ['dues_paid_this_year', 'duesFlow', v.openingDuesPaidKobo, 'dues_paid_total']]) {
      const m = money(c, f);
      if (m.error) { bad = m.error; break; }
      if (m.kobo > cap) { bad = `${f} (${fmtNaira(m.kobo)}) cannot be more than ${capName} (${fmtNaira(cap)}).`; break; }
      flows[key] = m.kobo;
    }
    if (bad) { errors.push({ line: v.line, error: bad }); continue; }
    valid.push({ ...v, ...flows });
  }
  const sum = f => valid.reduce((a, v) => a + v[f], 0);
  return { valid, errors, warnings: base.warnings, totals: { rows: valid.length, savings_kobo: sum('openingSavingsKobo'), shares_kobo: sum('openingSharesKobo'), dues_paid_kobo: sum('openingDuesPaidKobo') } };
}

function validateQLoans(rows, ctx) {
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
    if (!m) { fail(`No member matches "${c.member_no}". Load the members sheet first, and check the number.`); continue; }
    const principal = parseNaira(c.principal);
    if (principal == null || principal <= 0) { fail(`principal "${c.principal}" must be a positive naira figure.`); continue; }
    const method = LOAN_METHODS[String(c.interest_method || 'flat').trim().toLowerCase()];
    if (!method) { fail('interest_method must be flat, reducing_emi or reducing_declining.'); continue; }
    const rate = c.interest_rate_percent === '' ? 0 : Number(String(c.interest_rate_percent).replace('%', ''));
    if (!Number.isFinite(rate) || rate < 0 || rate > 1000) { fail(`interest_rate_percent "${c.interest_rate_percent}" is not a valid percentage.`); continue; }
    const months = Number(c.term_months);
    if (!Number.isInteger(months) || months < 1 || months > 120) { fail('term_months must be a whole number from 1 to 120.'); continue; }
    const day = parseFlexDay(c.disbursed_date);
    if (!day) { fail('disbursed_date must be a real date, YYYY-MM-DD or DD/MM/YYYY.'); continue; }
    if (day > ctx.batch.cutover_date) { fail(`disbursed_date cannot be after the cutover date (${ctx.batch.cutover_date}).`); continue; }
    const terms = computeLoanTerms(principal, method, rate, months, day);
    const to = money(c, 'repaid_to_date');
    if (to.error) { fail(to.error); continue; }
    if (to.kobo > terms.totalRepayableKobo) { fail(`repaid_to_date ${fmtNaira(to.kobo)} is more than the whole loan repayable (${fmtNaira(terms.totalRepayableKobo)}).`); continue; }
    const lentThisYear = day >= ctx.batch.fy_start;
    let yr = to.kobo;
    if (c.repaid_this_year !== '') {
      const y = money(c, 'repaid_this_year');
      if (y.error) { fail(y.error); continue; }
      yr = y.kobo;
    } else if (!lentThisYear) yr = 0;
    if (yr > to.kobo) { fail(`repaid_this_year (${fmtNaira(yr)}) cannot be more than repaid_to_date (${fmtNaira(to.kobo)}).`); continue; }
    if (lentThisYear && yr !== to.kobo) { fail('This loan was lent this financial year, so everything repaid on it was repaid this year. Make repaid_this_year equal repaid_to_date, or leave it blank.'); continue; }
    seen.add(key);
    valid.push({ line, ref, member: m, principalKobo: principal, method, rate, months, day, repaidToDateKobo: to.kobo, repaidThisYearKobo: yr, ...terms });
  }
  const sum = f => valid.reduce((a, v) => a + v[f], 0);
  return { valid, errors, warnings, totals: { rows: valid.length, amount_kobo: sum('principalKobo'), repaid_kobo: sum('repaidToDateKobo') } };
}

function validateQBalances(rows, ctx) {
  const valid = [], errors = [], warnings = [];
  const seen = new Set();
  for (const { line, cells: c } of rows) {
    const fail = msg => errors.push({ line, error: msg });
    const code = String(c.account_code || '').trim();
    const acc = ctx.chart.byCode.get(code) || ctx.chart.byName.get(code.toLowerCase());
    if (!acc) { fail(`No account "${code}" in the chart of accounts.`); continue; }
    if (AUTO_ACCOUNTS[acc.account_code]) { fail(`${acc.account_name} (${acc.account_code}) is worked out for you. ${AUTO_ACCOUNTS[acc.account_code]} Leave it out.`); continue; }
    if (seen.has(acc.account_code)) { fail(`Account ${acc.account_code} appears twice in this sheet.`); continue; }
    if (acc.currency !== ctx.chart.baseCurrency) { fail(`Account ${acc.account_code} is held in ${acc.currency}. Enter it as an ordinary journal entry instead.`); continue; }
    const kobo = parseNaira(c.balance);
    if (kobo == null || kobo <= 0) { fail(`balance "${c.balance}" must be a positive naira figure.`); continue; }
    const natural = ['ASSET', 'EXPENSE'].includes(acc.account_type) ? 'debit' : 'credit';
    const side = String(c.side || natural).trim().toLowerCase();
    if (!['debit', 'credit'].includes(side)) { fail('side must be debit or credit.'); continue; }
    seen.add(acc.account_code);
    valid.push({ line, account: acc, code: acc.account_code, amountKobo: kobo, side });
  }
  const dr = valid.filter(v => v.side === 'debit').reduce((a, v) => a + v.amountKobo, 0);
  const cr = valid.filter(v => v.side === 'credit').reduce((a, v) => a + v.amountKobo, 0);
  return { valid, errors, warnings, totals: { rows: valid.length, debits_kobo: dr, credits_kobo: cr } };
}

// ───────────────────────────── the position ─────────────────────────────

/**
 * Works out the whole opening position from the member sheets plus the society's own lines. With write, replaces the batch's
 * opening entry with it. Always returns the lines so the portal can show a proof before anything is approved.
 */
let injected = {};   // tests swap the sub-ledger calculation for a small stand-in
async function buildPosition(db, coopId, batchId, actor, { write = false, deps = injected } = {}) {
  const { data: batch } = await db.from('coop_migration_batches').select('*').eq('id', batchId).maybeSingle();
  if (!batch) return { built: false, reason: 'no_batch' };
  const ledger = Array.isArray(batch.quick_ledger) ? batch.quick_ledger : [];
  if (write) await deleteJournals(db, batch.id, 'opening_balances');
  if (!ledger.length) return { built: false, reason: 'no_trial_balance' };
  if (!(await hasAddon(db, coopId, 'accounting'))) return { built: false, reason: 'no_accounting' };

  const { data: soc } = await db.from('coop_societies').select('base_currency, dues_amount_kobo').eq('coop_id', coopId).maybeSingle();
  await ensureChartOfAccounts(db, coopId, (soc && soc.base_currency) || 'NGN');
  const accounts = await fetchAllRows(() => db.from('coop_chart_of_accounts').select('id, account_code, account_name, account_type, currency').eq('coop_id', coopId).order('id'));
  const byCode = new Map(accounts.map(a => [a.account_code, a]));
  const obe = byCode.get('3900');
  if (!obe) throw new Error('Opening Balance Equity is missing from the chart of accounts. Contact support.');

  // What members and loans account for, from the same calculation the reconcile uses, so the two cannot disagree.
  const memberTotal = {};
  for (const type of ['savings', 'shares', 'loans', 'dues']) {
    const r = await (deps.computeSubledger || computeSubledger)(db, coopId, type, batch.cutover_date);
    for (const c of r.reconciliation) memberTotal[c.account_codes[0]] = c.members_kobo;
  }

  // Income earned in the year to date that the member sheets produce.
  const rate = Number(soc && soc.dues_amount_kobo) || 0;
  let duesIncome = 0;
  if (rate > 0) {
    const members = await fetchAllRows(() => db.from('coop_members').select('id, activated_at').eq('coop_id', coopId).order('id'));
    const [y, m] = [Number(batch.fy_start.slice(0, 4)), Number(batch.fy_start.slice(5, 7)) - 1];
    const before = computeTotalDuesAccrued(members, rate, new Date(Date.UTC(y, m, 0, 12)));
    const upto = computeTotalDuesAccrued(members, rate, new Date(batch.cutover_date + 'T12:00:00Z'));
    duesIncome = Math.max(0, upto - before);
  }
  const loans = await fetchAllRows(() => db.from('coop_loans').select('id, interest_kobo, disbursed_at').eq('coop_id', coopId).eq('migration_batch_id', batch.id).order('id'));
  const loanInterestIncome = loans.filter(l => String(l.disbursed_at).slice(0, 10) >= batch.fy_start).reduce((a, l) => a + Number(l.interest_kobo || 0), 0);

  const lines = [];
  const add = (code, side, amount, source) => { const a = byCode.get(code); if (a && amount > 0) lines.push({ account: a, code, name: a.account_name, type: a.account_type, side, amountKobo: amount, source }); };
  const signed = (code, amount, normalSide, source) => amount >= 0 ? add(code, normalSide, amount, source) : add(code, normalSide === 'debit' ? 'credit' : 'debit', -amount, source);
  signed('2000', memberTotal['2000'] || 0, 'credit', 'members');
  signed('3000', memberTotal['3000'] || 0, 'credit', 'members');
  signed('2200', memberTotal['2200'] || 0, 'credit', 'members');
  signed('1100', memberTotal['1100'] || 0, 'debit', 'loans');
  signed('1110', memberTotal['1110'] || 0, 'debit', 'loans');
  signed('1150', memberTotal['1150'] || 0, 'debit', 'members');
  add('4100', 'credit', duesIncome, 'members');
  add('4150', 'credit', loanInterestIncome, 'loans');
  const missing = [];
  for (const l of ledger) {
    const a = byCode.get(l.code);
    if (!a) { missing.push(l.code); continue; }
    lines.push({ account: a, code: l.code, name: a.account_name, type: a.account_type, side: l.side, amountKobo: l.amountKobo, source: 'society' });
  }
  if (missing.length) throw new Error(`The trial balance uses accounts that are no longer in the chart: ${missing.join(', ')}.`);

  const dr = lines.filter(l => l.side === 'debit').reduce((a, l) => a + l.amountKobo, 0);
  const cr = lines.filter(l => l.side === 'credit').reduce((a, l) => a + l.amountKobo, 0);
  const plug = dr - cr;       // positive: debits exceed credits, so Opening Balance Equity is credited
  const surplus = lines.reduce((a, l) => a + (l.type === 'INCOME' ? (l.side === 'credit' ? l.amountKobo : -l.amountKobo) : l.type === 'EXPENSE' ? (l.side === 'debit' ? -l.amountKobo : l.amountKobo) : 0), 0);
  const position = {
    built: true, as_of: batch.cutover_date, fy_start: batch.fy_start,
    lines: lines.map(l => ({ code: l.code, name: l.name, type: l.type, side: l.side, amount_kobo: l.amountKobo, source: l.source })),
    member_totals: { savings_kobo: memberTotal['2000'] || 0, shares_kobo: memberTotal['3000'] || 0, loan_principal_kobo: memberTotal['1100'] || 0, loan_interest_kobo: memberTotal['1110'] || 0, dues_owed_kobo: memberTotal['1150'] || 0 },
    income: { dues_kobo: duesIncome, loan_interest_kobo: loanInterestIncome },
    debits_kobo: dr, credits_kobo: cr, equity_plug_kobo: plug, surplus_kobo: surplus,
  };
  if (!write) return position;

  const entryLines = lines.map(l => ({ accountId: l.account.id, type: l.side, amount: l.amountKobo, currency: l.account.currency, memo: l.source === 'society' ? null : 'Worked out from the member and loan sheets' }));
  if (plug !== 0) entryLines.push({ accountId: obe.id, type: plug > 0 ? 'credit' : 'debit', amount: Math.abs(plug), currency: obe.currency, memo: 'Opening balance offset' });
  const number = await nextEntryNumber(db, coopId);
  const { data: entry, error } = await db.from('coop_journal_entries').insert({
    coop_id: coopId, entry_number: number, entry_date: batch.cutover_date,
    description: `Opening position, as of ${batch.cutover_date} (income and expenses are the totals for the year to date)`,
    entry_type: 'opening_balance', created_by: actor, migration_batch_id: batch.id, migration_dataset: 'opening_balances',
  }).select().single();
  if (error) throw new Error(`Could not create the opening entry: ${error.message}`);
  const { error: linesErr } = await db.from('coop_journal_entry_lines').insert(entryLines.map(l => ({
    journal_entry_id: entry.id, coop_id: coopId, account_id: l.accountId, line_type: l.type, amount: l.amount, currency: l.currency,
    exchange_rate: 1, base_amount: l.amount, memo: l.memo || null,
  })));
  if (linesErr) { await db.from('coop_journal_entries').delete().eq('id', entry.id); throw new Error(`Could not save the opening entry lines: ${linesErr.message}`); }
  return position;
}

/** Quietly rebuilds the opening entry after the member or loan sheets change. */
async function rebuild(db, ctx, actor) {
  try { await buildPosition(db, ctx.coopId, ctx.batch.id, actor, { write: true }); }
  catch (e) { throw new Error(`The sheet loaded, but the opening entry could not be rebuilt (${e.message}). Load the trial balance again.`); }
}

// ───────────────────────────── applying ─────────────────────────────

const midDay = (a, b) => { const x = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10)), y = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)); return new Date((x + y) / 2).toISOString().slice(0, 10); };

async function applyQMembers(db, ctx, valid, actor) {
  const cap = await checkMemberCapAllows(db, ctx.coopId, valid.filter(v => !v.exitedOn).length);
  if (!cap.ok) throw new Error(cap.error);
  const errors = [], created = [];
  for (const v of valid) {
    const r = await activateMember(db, {
      coopId: ctx.coopId, rawPhone: v.phone, name: v.name, openingBalanceKobo: v.openingSavingsKobo - v.savingsFlow, activatedBy: actor, postcode: v.postcode,
      joinedOn: v.joinedOn, exitedOn: v.exitedOn, exitReason: v.exitReason, migrationBatchId: ctx.batch.id, memberNumber: v.memberNo,
    });
    if (r.status === 'created') created.push({ v, member: r.member });
    else if (r.status === 'already_existed') errors.push({ line: v.line, error: 'Already a member, skipped.' });
    else errors.push({ line: v.line, error: r.error });
  }
  const { fy_start: fy, cutover_date: cut } = ctx.batch;
  const before = stamp(dayBefore(fy));
  const mk = (m, amount, at, label) => ({ coop_id: ctx.coopId, member_id: m.id, amount_kobo: amount, source: 'migration_opening', reference: label, recorded_by: actor, recorded_at: at, migration_batch_id: ctx.batch.id });
  const shareRows = [], duesRows = [];
  for (const { v, member } of created) {
    if (v.openingSharesKobo - v.sharesFlow > 0) shareRows.push(mk(member, v.openingSharesKobo - v.sharesFlow, before, 'Held before the financial year'));
    if (v.sharesFlow > 0) shareRows.push(mk(member, v.sharesFlow, stamp(midDay(v.joinedOn > fy ? v.joinedOn : fy, cut)), 'Bought this financial year (dated midway for the dividend)'));
    if (v.openingDuesPaidKobo - v.duesFlow > 0) duesRows.push(mk(member, v.openingDuesPaidKobo - v.duesFlow, before, 'Paid before the financial year'));
    if (v.duesFlow > 0) duesRows.push(mk(member, v.duesFlow, stamp(cut), 'Paid this financial year'));
  }
  const planRows = created.filter(c => c.v.openingSavingsKobo > 0).map(c => ({
    coop_id: ctx.coopId, member_id: c.member.id, target_amount_kobo: Math.max(1, c.v.openingSavingsKobo), monthly_contribution_kobo: 0, duration_months: 12,
    start_date: fy, status: 'ACTIVE', created_by: `go_live:${ctx.batch.id}`,
  }));
  const planByMember = new Map();
  for (const part of chunk(planRows, 200)) {
    const { data, error } = await db.from('coop_savings_plans').insert(part).select('id, member_id');
    if (error) throw new Error(`The members loaded, but their savings did not (${error.message}). Clear the members sheet and load it again.`);
    for (const p of data || []) planByMember.set(p.member_id, p.id);
  }
  const savingsRows = created.filter(c => c.v.savingsFlow > 0 && planByMember.has(c.member.id)).map(c => ({
    coop_id: ctx.coopId, member_id: c.member.id, savings_plan_id: planByMember.get(c.member.id), amount_kobo: c.v.savingsFlow, source: 'migration_opening',
    reference: 'Added this financial year', recorded_by: actor, recorded_at: stamp(cut), migration_batch_id: ctx.batch.id,
  }));
  for (const [table, rows] of [['coop_share_transactions', shareRows], ['coop_dues_transactions', duesRows], ['coop_savings_transactions', savingsRows]]) {
    for (const part of chunk(rows, 200)) {
      const { error } = await db.from(table).insert(part);
      if (error) throw new Error(`The members loaded, but their balances did not (${error.message}). Clear the members sheet and load it again.`);
    }
  }
  await rebuild(db, ctx, actor);
  return { applied: created.length, extraErrors: errors, journals: { posted: 0, skipped: null } };
}

async function applyQLoans(db, ctx, valid, actor) {
  const rows = valid.map(v => ({
    coop_id: ctx.coopId, member_id: v.member.id, principal_kobo: v.principalKobo, interest_rate_percent: v.rate, interest_kobo: v.interestKobo,
    total_repayable_kobo: v.totalRepayableKobo, repayment_months: v.months, monthly_repayment_kobo: Math.ceil(v.totalRepayableKobo / v.months),
    status: 'DISBURSED', requested_at: stamp(v.day), approved_at: stamp(v.day), approved_by: 'go_live_import', disbursed_at: stamp(v.day),
    interest_method: v.method, reducing_balance_monthly_rate_percent: v.reducingRate, migration_batch_id: ctx.batch.id, import_ref: v.ref,
  }));
  const created = [];
  try {
    for (const part of chunk(rows, 100)) {
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
    // Repayments to date as two markers: before the year began, and this year. Each carries its principal and interest split.
    const reps = [];
    for (const v of valid) {
      const id = idByRef.get(v.ref.toLowerCase());
      const preAmt = v.repaidToDateKobo - v.repaidThisYearKobo;
      let paid = 0, interestPaid = 0;
      for (const [amt, at, label] of [[preAmt, stamp(dayBefore(ctx.batch.fy_start)), 'Repaid before the financial year'], [v.repaidThisYearKobo, stamp(ctx.batch.cutover_date), 'Repaid this financial year']]) {
        if (amt <= 0) continue;
        const s = v.method === 'flat' ? computeRepaymentSplit(amt, v.interestKobo, v.totalRepayableKobo, interestPaid) : computeReducingBalanceSplit(v.schedule, paid, amt);
        paid += amt; interestPaid += s.interestPortionKobo;
        reps.push({ loan_id: id, amount_kobo: amt, source: 'migration_opening', reference: label, recorded_by: actor, recorded_at: at, principal_portion_kobo: s.principalPortionKobo, interest_portion_kobo: s.interestPortionKobo, migration_batch_id: ctx.batch.id });
      }
    }
    for (const part of chunk(reps, 200)) {
      const { error } = await db.from('coop_loan_repayments').insert(part);
      if (error) throw new Error(`Could not record repayments to date: ${error.message}`);
    }
    await refreshLoanStatuses(db, created.map(l => l.id));
  } catch (e) {
    const ids = created.map(l => l.id);
    for (const part of chunk(ids)) {
      await db.from('coop_loan_repayments').delete().in('loan_id', part);
      await db.from('coop_loan_repayment_schedule').delete().in('loan_id', part);
      await db.from('coop_loans').delete().in('id', part);
    }
    throw e;
  }
  await rebuild(db, ctx, actor);
  return { applied: valid.length, extraErrors: [], journals: { posted: 0, skipped: null } };
}

async function applyQBalances(db, ctx, valid, actor) {
  const ledger = valid.map(v => ({ code: v.code, side: v.side, amountKobo: v.amountKobo }));
  const { error } = await db.from('coop_migration_batches').update({ quick_ledger: ledger }).eq('id', ctx.batch.id);
  if (error) throw new Error(`Could not save the trial balance: ${error.message}`);
  try { await buildPosition(db, ctx.coopId, ctx.batch.id, actor, { write: true }); }
  catch (e) { await db.from('coop_migration_batches').update({ quick_ledger: null }).eq('id', ctx.batch.id); throw e; }
  return { applied: valid.length, extraErrors: [], journals: { posted: 1, skipped: null } };
}

// ───────────────────────────── clearing ─────────────────────────────

async function clearQMembers(db, batch) {
  const counts = await imp.countBatch(db, batch.id);
  if (counts.loans > 0) throw new Error('Clear the loans first, because they depend on the members.');
  for (const t of ['coop_savings_transactions', 'coop_share_transactions', 'coop_dues_transactions']) await db.from(t).delete().eq('migration_batch_id', batch.id);
  await db.from('coop_savings_plans').delete().eq('created_by', `go_live:${batch.id}`);
  await db.from('coop_members').delete().eq('migration_batch_id', batch.id);
  try { await buildPosition(db, batch.coop_id, batch.id, 'system', { write: true }); } catch (e) { /* the next load rebuilds it */ }
}
async function clearQLoans(db, batch) {
  const loans = await fetchAllRows(() => db.from('coop_loans').select('id').eq('migration_batch_id', batch.id).order('id'));
  for (const part of chunk(loans.map(l => l.id))) {
    await db.from('coop_loan_repayments').delete().in('loan_id', part);
    await db.from('coop_loan_repayment_schedule').delete().in('loan_id', part);
    await db.from('coop_loans').delete().in('id', part);
  }
  try { await buildPosition(db, batch.coop_id, batch.id, 'system', { write: true }); } catch (e) { /* the next load rebuilds it */ }
}
async function clearQBalances(db, batch) {
  await deleteJournals(db, batch.id, 'opening_balances');
  await db.from('coop_migration_batches').update({ quick_ledger: null }).eq('id', batch.id);
}

async function gateQBalances(db, coopId, batch) {
  if (!(await hasAddon(db, coopId, 'accounting'))) return 'The trial balance is booked in the society\'s accounts, which needs the Accounting & Finance module on the current plan.';
  const { data: existing } = await db.from('coop_journal_entries').select('id, migration_batch_id').eq('coop_id', coopId).eq('entry_type', 'opening_balance').limit(1).maybeSingle();
  if (existing && existing.migration_batch_id !== batch.id) return 'Opening balances were already set for this society outside the go-live batch. Make adjustments with a normal journal entry.';
  return null;
}

imp.registerDataset('q_members', { spec: SPECS.q_members, maxRows: 200, base: 'members', validate: validateQMembers, apply: applyQMembers, clear: clearQMembers });
imp.registerDataset('q_loans', { spec: SPECS.q_loans, maxRows: 300, base: 'loans', validate: validateQLoans, apply: applyQLoans, clear: clearQLoans });
imp.registerDataset('q_balances', { spec: SPECS.q_balances, maxRows: 200, base: 'opening_balances', validate: validateQBalances, apply: applyQBalances, clear: clearQBalances, gate: gateQBalances });

module.exports = { setTestDeps: d => { injected = d || {}; }, SPECS, AUTO_ACCOUNTS, buildPosition, validateQMembers, validateQLoans, validateQBalances, QUICK_ORDER: ['q_members', 'q_loans', 'q_balances'] };
