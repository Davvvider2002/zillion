/**
 * zillion/backend/lib/coopGoLiveBooks.js
 *
 * Go-live catch-up, phase 3: the books. Three jobs.
 *
 *  1. postDatedDuesAccrual: income is earned as the months pass, not when it is collected. The live nightly job books
 *     it as one lump dated today. For the replayed year it books one entry per month, dated the month end, using the
 *     very same dues arithmetic (lib/coopDues.js), so the figures agree with the dues sub-ledger.
 *  2. setDuesAccrualBaseline: at lock, tells the live job how much has already been accrued, so it carries on from the
 *     cutover month instead of booking the year again.
 *  3. reconcileBatch: the member sub-ledgers against the general ledger's control accounts, at the cutover date, plus
 *     the income and expenditure for the year. A gap is shown as it is. It never gets forced to zero.
 */
'use strict';

const { fetchAllRows } = require('./coopPaginate');
const { computeTotalDuesAccrued } = require('./coopDues');
const { accountingIsReady, getAccounts } = require('./coopAccountingHelpers');
const { postJournalBatch, deleteJournals } = require('./coopGoLiveImport');
const { computeSubledger } = require('./coopSubledgers');
const { computeIncomeExpenditure } = require('./coopFinancialReports');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const RECONCILED_TYPES = ['savings', 'loans', 'dues', 'shares'];

/** Month ends from the financial year start month to the cutover month, the last one capped at the cutover date. */
function monthEnds(fyStart, cutover) {
  const out = [];
  let y = Number(fyStart.slice(0, 4)), m = Number(fyStart.slice(5, 7)) - 1;
  const endY = Number(cutover.slice(0, 4)), endM = Number(cutover.slice(5, 7)) - 1;
  while (y < endY || (y === endY && m <= endM)) {
    const last = new Date(Date.UTC(y, m + 1, 0));
    const day = last.toISOString().slice(0, 10);
    out.push({ label: `${MONTHS[m]} ${y}`, entryDate: day > cutover ? cutover : day, asOf: new Date(Date.UTC(y, m + 1, 0, 12)) });
    m++; if (m > 11) { m = 0; y++; }
  }
  return out;
}

/**
 * Replaces any earlier run, so it can be repeated until the batch is locked.
 * @returns {{ok:true, months:Array<{month:string, amount_kobo:number}>, total_kobo:number, entries:number} | {ok:false, error:string}}
 */
async function postDatedDuesAccrual(db, coopId, batch, actor) {
  if (batch.status !== 'draft') return { ok: false, error: `This batch is ${batch.status}. Only a draft batch can be changed.` };
  if (!(await accountingIsReady(db, coopId))) return { ok: false, error: 'Load the opening balances first. The accrual is booked into the accounts.' };
  const { data: society } = await db.from('coop_societies').select('dues_amount_kobo').eq('coop_id', coopId).maybeSingle();
  const rate = Number(society && society.dues_amount_kobo) || 0;
  await deleteJournals(db, batch.id, 'dues_accrual');
  if (rate <= 0) return { ok: true, months: [], total_kobo: 0, entries: 0, note: 'This society charges no dues, so there is nothing to accrue.' };

  const acc = await getAccounts(db, coopId, ['1150', '4100']);
  if (!acc['1150'] || !acc['4100']) return { ok: false, error: 'Dues Receivable or Dues Income is missing from the chart of accounts.' };
  const members = await fetchAllRows(() => db.from('coop_members').select('id, activated_at').eq('coop_id', coopId).order('id'));

  const ends = monthEnds(batch.fy_start, batch.cutover_date);
  // What was already accrued before the year began sits in the opening balances; start the running figure there.
  let prev = computeTotalDuesAccrued(members, rate, new Date(Date.UTC(Number(batch.fy_start.slice(0, 4)), Number(batch.fy_start.slice(5, 7)) - 1, 0, 12)));
  const months = [], entries = [];
  for (const e of ends) {
    const total = computeTotalDuesAccrued(members, rate, e.asOf);
    const delta = total - prev;
    prev = total;
    if (delta <= 0) continue;
    months.push({ month: e.label, amount_kobo: delta });
    entries.push({ date: e.entryDate, description: `Dues income accrued — ${e.label}`, lines: [{ account: acc['1150'], type: 'debit', amountKobo: delta }, { account: acc['4100'], type: 'credit', amountKobo: delta }] });
  }
  if (entries.length) await postJournalBatch(db, coopId, entries, actor, { batchId: batch.id, dataset: 'dues_accrual' });
  return { ok: true, months, total_kobo: months.reduce((a, m) => a + m.amount_kobo, 0), entries: entries.length };
}

/** For the lock step: the live accrual job compares its total with this, so it books only what comes after the cutover. */
async function setDuesAccrualBaseline(db, coopId, batch) {
  const { data: society } = await db.from('coop_societies').select('dues_amount_kobo').eq('coop_id', coopId).maybeSingle();
  const rate = Number(society && society.dues_amount_kobo) || 0;
  const members = await fetchAllRows(() => db.from('coop_members').select('id, activated_at').eq('coop_id', coopId).eq('status', 'ACTIVE').order('id'));
  const baseline = computeTotalDuesAccrued(members, rate, new Date(batch.cutover_date + 'T12:00:00Z'));
  await db.from('coop_societies').update({ dues_income_accrued_kobo: baseline }).eq('coop_id', coopId);
  return baseline;
}

/**
 * @returns the four sub-ledger reconciliations at the cutover date, the year's income and expenditure, and an overall
 * verdict. `blocking` lists every control account that does not tie out, in words.
 */
async function reconcileBatch(db, coopId, batch, deps = {}) {
  const subledger = deps.computeSubledger || computeSubledger;
  const incomeExp = deps.computeIncomeExpenditure || computeIncomeExpenditure;
  const items = [], blocking = [];
  for (const type of RECONCILED_TYPES) {
    const r = await subledger(db, coopId, type, batch.cutover_date);
    items.push({ type: r.type, title: r.title, reconciled: r.reconciled, controls: r.reconciliation.map(c => ({ label: c.label, account_codes: c.account_codes, gl_kobo: c.gl_kobo, members_kobo: c.members_kobo, unallocated_kobo: c.unallocated_kobo })), unresolved_member_records: r.unresolved_member_records });
    for (const c of r.reconciliation) {
      if (c.unallocated_kobo !== 0) blocking.push(`${c.label} (${c.account_codes.join(', ')}): the ledger holds ${c.gl_kobo}, members account for ${c.members_kobo}, a gap of ${c.unallocated_kobo} kobo.`);
    }
    if (r.unresolved_member_records) blocking.push(`${r.title}: some records point to a member that no longer resolves.`);
  }
  const ie = await incomeExp(db, coopId, batch.cutover_date, batch.fy_start);
  return {
    batch_id: batch.id, as_of: batch.cutover_date, fy_start: batch.fy_start, reconciled: blocking.length === 0, blocking, items,
    income_expenditure: { total_income_kobo: ie.total_income, total_expense_kobo: ie.total_expense, surplus_kobo: ie.net },
  };
}

module.exports = { postDatedDuesAccrual, setDuesAccrualBaseline, reconcileBatch, monthEnds };
