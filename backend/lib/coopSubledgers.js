/**
 * zillion/backend/lib/coopSubledgers.js
 *
 * Sub-ledgers: the member-by-member make-up of the trial balance's control
 * accounts. Savings by member -> 2000, Loans -> 1100 + 1110, Dues -> 1150,
 * Investments -> 2210, Shares & dividends -> 3000 + 2200.
 *
 * Every figure is computed live from the operational records (never stored),
 * and every sub-ledger ends in a RECONCILIATION against the general ledger's
 * control account(s): total by member, the ledger balance, and the
 * difference. That difference is shown, never hidden or forced to zero -
 * opening balances entered as a lump sum, or entries with no member attached,
 * legitimately sit in the ledger without a member behind them, and a report
 * that pretended otherwise would be worse than none. Real example: one
 * society's ledger held NGN 5,499,978 of share capital while only NGN 500,000
 * was attributable to members through transactions.
 *
 * Amounts are in kobo. Signs follow the account: a receivable is positive
 * when members OWE the society, a payable/equity balance is positive when
 * the society owes or holds it for members - matching computeAccountBalances,
 * so member totals and ledger balances compare directly.
 */
'use strict';

const { fetchAllRows, chunk } = require('./coopPaginate');
const { calculateDuesScheduleByYear } = require('./coopDues');
const financialReports = require('./coopFinancialReports');

const num = v => Number(v) || 0;
const bucket = (map, id, init) => { if (!map.has(id)) map.set(id, { ...init }); return map.get(id); };

// ---------------------------------------------------------------- collectors
// Each returns Map<member_id, { ...column values }> using bulk, paged queries.

async function collectSavings(db, coopId, cutoff, members) {
  const txns = await fetchAllRows(() => {
    let q = db.from('coop_savings_transactions').select('id, member_id, amount_kobo, source, recorded_at').eq('coop_id', coopId).order('id');
    if (cutoff) q = q.lte('recorded_at', cutoff);
    return q;
  });
  const m = new Map();
  const blank = { opening: 0, contributions: 0, interest: 0, balance: 0 };
  // A member's opening savings balance lives on the member record itself and is
  // added to their savings everywhere the platform shows a balance. It is NOT
  // posted to the ledger when a member is activated, so a savings sub-ledger
  // that left it out would understate what members are owed - and disagree
  // with what members see in the app.
  for (const mem of members) {
    const opening = num(mem.opening_balance_kobo);
    if (opening) { const v = bucket(m, mem.id, blank); v.opening += opening; v.balance += opening; }
  }
  for (const t of txns) {
    const v = bucket(m, t.member_id, blank);
    if (t.source === 'interest_credit') v.interest += num(t.amount_kobo); else v.contributions += num(t.amount_kobo);
    v.balance += num(t.amount_kobo);
  }
  return m;
}

/** Members whose opening balance the app cannot show them (it is displayed via a savings plan). */
async function membersWithoutSavingsPlan(db, coopId) {
  const plans = await fetchAllRows(() => db.from('coop_savings_plans').select('id, member_id').eq('coop_id', coopId).order('id'));
  const has = new Set(plans.map(p => p.member_id));
  return id => !has.has(id);
}

async function loadLoansAndRepayments(db, coopId, cutoff) {
  const loans = await fetchAllRows(() => {
    let q = db.from('coop_loans').select('id, member_id, principal_kobo, interest_kobo, disbursed_at').eq('coop_id', coopId).not('disbursed_at', 'is', null).order('id');
    if (cutoff) q = q.lte('disbursed_at', cutoff);
    return q;
  });
  const repayments = [];
  for (const ids of chunk(loans.map(l => l.id))) {
    repayments.push(...await fetchAllRows(() => {
      let q = db.from('coop_loan_repayments').select('id, loan_id, principal_portion_kobo, interest_portion_kobo, amount_kobo, recorded_at').in('loan_id', ids).order('id');
      if (cutoff) q = q.lte('recorded_at', cutoff);
      return q;
    }));
  }
  return { loans, repayments };
}

async function collectLoans(db, coopId, cutoff) {
  const { loans, repayments } = await loadLoansAndRepayments(db, coopId, cutoff);
  const owner = new Map(loans.map(l => [l.id, l.member_id]));
  const m = new Map();
  const blank = { principal_disbursed: 0, principal_repaid: 0, principal_outstanding: 0, interest_charged: 0, interest_repaid: 0, interest_outstanding: 0 };
  for (const l of loans) { const v = bucket(m, l.member_id, blank); v.principal_disbursed += num(l.principal_kobo); v.interest_charged += num(l.interest_kobo); }
  for (const r of repayments) {
    const v = bucket(m, owner.get(r.loan_id), blank);
    v.principal_repaid += num(r.principal_portion_kobo); v.interest_repaid += num(r.interest_portion_kobo);
  }
  for (const v of m.values()) { v.principal_outstanding = v.principal_disbursed - v.principal_repaid; v.interest_outstanding = v.interest_charged - v.interest_repaid; }
  return m;
}

async function collectDues(db, coopId, cutoff, members, asOfDate) {
  const { data: society } = await db.from('coop_societies').select('dues_amount_kobo').eq('coop_id', coopId).maybeSingle();
  const rate = num(society && society.dues_amount_kobo);
  const m = new Map();
  if (rate <= 0) return m;
  const txns = await fetchAllRows(() => {
    let q = db.from('coop_dues_transactions').select('id, member_id, amount_kobo, recorded_at').eq('coop_id', coopId).order('id');
    if (cutoff) q = q.lte('recorded_at', cutoff);
    return q;
  });
  const paid = new Map();
  for (const t of txns) paid.set(t.member_id, (paid.get(t.member_id) || 0) + num(t.amount_kobo));
  for (const mem of members) {
    if (!mem.activated_at) continue;
    const accrued = calculateDuesScheduleByYear(mem.activated_at, asOfDate).reduce((s, y) => s + y.months_owed * rate, 0);
    const p = paid.get(mem.id) || 0;
    // Unclamped on purpose: a prepayment is a real credit in the ledger, so it
    // must count here or the two sides drift apart by exactly that amount.
    m.set(mem.id, { accrued, paid: p, balance: accrued - p });
  }
  return m;
}

async function collectInvestments(db, coopId, cutoff) {
  const invs = await fetchAllRows(() => {
    let q = db.from('coop_member_investments').select('id, member_id, principal_kobo, purchased_at, withdrawn_at').eq('coop_id', coopId).order('id');
    if (cutoff) q = q.lte('purchased_at', cutoff);
    return q;
  });
  const accruals = [];
  for (const ids of chunk(invs.map(i => i.id))) {
    accruals.push(...await fetchAllRows(() => {
      let q = db.from('coop_investment_accruals').select('id, member_investment_id, amount_kobo, accrued_at').in('member_investment_id', ids).order('id');
      if (cutoff) q = q.lte('accrued_at', cutoff);
      return q;
    }));
  }
  const gone = i => i.withdrawn_at && (!cutoff || i.withdrawn_at <= cutoff);
  const byInv = new Map(invs.map(i => [i.id, i]));
  const m = new Map();
  const blank = { principal: 0, accrued_returns: 0, balance: 0 };
  for (const i of invs) { if (gone(i)) continue; bucket(m, i.member_id, blank).principal += num(i.principal_kobo); }
  for (const a of accruals) { const i = byInv.get(a.member_investment_id); if (!i || gone(i)) continue; bucket(m, i.member_id, blank).accrued_returns += num(a.amount_kobo); }
  for (const v of m.values()) v.balance = v.principal + v.accrued_returns;
  return m;
}

async function collectShares(db, coopId, cutoff) {
  const shareTxns = await fetchAllRows(() => {
    let q = db.from('coop_share_transactions').select('id, member_id, amount_kobo, recorded_at').eq('coop_id', coopId).order('id');
    if (cutoff) q = q.lte('recorded_at', cutoff);
    return q;
  });
  const m = new Map();
  const blank = { share_capital: 0, dividends_declared: 0, dividends_paid: 0, dividends_payable: 0 };
  for (const t of shareTxns) bucket(m, t.member_id, blank).share_capital += num(t.amount_kobo);

  // Dividends count as payable only once the run has been approved and its
  // payable booked to the ledger (2200) - the same event that creates the
  // liability on the general-ledger side.
  const runs = await fetchAllRows(() => {
    let q = db.from('coop_dividend_runs').select('id, approved_at').eq('coop_id', coopId).eq('payable_booked', true).order('id');
    if (cutoff) q = q.lte('approved_at', cutoff);
    return q;
  });
  const runIds = runs.map(r => r.id);
  const entitlementOwner = new Map();
  for (const ids of chunk(runIds)) {
    const ents = await fetchAllRows(() => db.from('coop_dividend_entitlements').select('id, member_id, entitlement_kobo').in('dividend_run_id', ids).order('id'));
    for (const e of ents) { entitlementOwner.set(e.id, e.member_id); bucket(m, e.member_id, blank).dividends_declared += num(e.entitlement_kobo); }
  }
  for (const ids of chunk([...entitlementOwner.keys()])) {
    const pays = await fetchAllRows(() => {
      let q = db.from('coop_dividend_payouts').select('id, entitlement_id, amount_kobo, completed_at').in('entitlement_id', ids).eq('status', 'completed').order('id');
      if (cutoff) q = q.lte('completed_at', cutoff);
      return q;
    });
    for (const p of pays) bucket(m, entitlementOwner.get(p.entitlement_id), blank).dividends_paid += num(p.amount_kobo);
  }
  for (const v of m.values()) v.dividends_payable = v.dividends_declared - v.dividends_paid;
  return m;
}

// ------------------------------------------------------------------- config
const SUBLEDGERS = {
  savings: {
    title: 'Savings by member',
    columns: [{ key: 'opening', label: 'Opening balance' }, { key: 'contributions', label: 'Deposits & credits' }, { key: 'interest', label: 'Interest credited' }, { key: 'balance', label: 'Balance' }],
    controls: [{ label: 'Member Savings Payable', codes: ['2000'], key: 'balance' }],
    collect: (db, coopId, cutoff, members) => collectSavings(db, coopId, cutoff, members),
  },
  loans: {
    title: 'Loans by member',
    columns: [{ key: 'principal_disbursed', label: 'Principal lent' }, { key: 'principal_repaid', label: 'Principal repaid' }, { key: 'principal_outstanding', label: 'Principal outstanding' },
              { key: 'interest_charged', label: 'Interest charged' }, { key: 'interest_repaid', label: 'Interest repaid' }, { key: 'interest_outstanding', label: 'Interest outstanding' }],
    controls: [{ label: 'Loan Principal Receivable', codes: ['1100'], key: 'principal_outstanding' }, { label: 'Loan Interest Receivable', codes: ['1110'], key: 'interest_outstanding' }],
    collect: (db, coopId, cutoff) => collectLoans(db, coopId, cutoff),
  },
  dues: {
    title: 'Member dues',
    columns: [{ key: 'accrued', label: 'Dues charged' }, { key: 'paid', label: 'Paid' }, { key: 'balance', label: 'Outstanding' }],
    controls: [{ label: 'Dues Receivable', codes: ['1150'], key: 'balance' }],
    collect: (db, coopId, cutoff, members, asOfDate) => collectDues(db, coopId, cutoff, members, asOfDate),
  },
  investments: {
    title: 'Investments by member',
    columns: [{ key: 'principal', label: 'Principal invested' }, { key: 'accrued_returns', label: 'Returns accrued' }, { key: 'balance', label: 'Balance owed to member' }],
    controls: [{ label: 'Member Investment Payable', codes: ['2210'], key: 'balance' }],
    collect: (db, coopId, cutoff) => collectInvestments(db, coopId, cutoff),
  },
  shares: {
    title: 'Shareholding & dividends',
    columns: [{ key: 'share_capital', label: 'Share capital' }, { key: 'dividends_declared', label: 'Dividends declared' }, { key: 'dividends_paid', label: 'Dividends paid out' }, { key: 'dividends_payable', label: 'Dividends payable' }],
    controls: [{ label: 'Share Capital', codes: ['3000'], key: 'share_capital' }, { label: 'Dividend Payable', codes: ['2200'], key: 'dividends_payable' }],
    collect: (db, coopId, cutoff) => collectShares(db, coopId, cutoff),
  },
};

/**
 * @param {string} asOf 'YYYY-MM-DD' or null (everything to date)
 * @param {object} [deps] injectable for tests
 */
async function computeSubledger(db, coopId, type, asOf = null, deps = {}) {
  const cfg = SUBLEDGERS[type];
  if (!cfg) return null;
  const computeAccountBalances = deps.computeAccountBalances || financialReports.computeAccountBalances;
  const cutoff = asOf ? `${asOf}T23:59:59.999Z` : null;
  const asOfDate = asOf ? new Date(`${asOf}T12:00:00Z`) : new Date();

  const members = await fetchAllRows(() => db.from('coop_members').select('id, name, phone_normalized, activated_at, opening_balance_kobo').eq('coop_id', coopId).order('id'));
  const perMember = await cfg.collect(db, coopId, cutoff, members, asOfDate);

  const keys = cfg.columns.map(c => c.key);
  const totals = Object.fromEntries(keys.map(k => [k, 0]));
  const rows = [];
  const noPlan = type === 'savings' ? await membersWithoutSavingsPlan(db, coopId) : null;
  for (const mem of members) {
    const v = perMember.get(mem.id);
    if (!v || keys.every(k => !v[k])) continue;
    const notes = [];
    if (noPlan && v.opening > 0 && noPlan(mem.id)) notes.push({ code: 'opening_not_visible', amount_kobo: v.opening });
    rows.push({ member_id: mem.id, member_name: mem.name || mem.phone_normalized || 'Unnamed member', phone_normalized: mem.phone_normalized, values: Object.fromEntries(keys.map(k => [k, v[k] || 0])), notes });
    for (const k of keys) totals[k] += v[k] || 0;
  }
  // Records whose member no longer resolves (should not happen, but must not vanish silently).
  const known = new Set(members.map(m => m.id));
  const orphan = Object.fromEntries(keys.map(k => [k, 0]));
  for (const [id, v] of perMember) if (!known.has(id)) for (const k of keys) orphan[k] += v[k] || 0;
  const orphanTotal = keys.reduce((s, k) => s + Math.abs(orphan[k]), 0);
  for (const k of keys) totals[k] += orphan[k];
  rows.sort((a, b) => a.member_name.localeCompare(b.member_name));

  const balances = await computeAccountBalances(db, coopId, asOf);
  const reconciliation = cfg.controls.map(c => {
    const accounts = c.codes.map(code => balances.find(b => b.account_code === code)).filter(Boolean)
      .map(a => ({ id: a.id, code: a.account_code, name: a.account_name, balance_kobo: a.balance }));
    const glKobo = accounts.reduce((s, a) => s + a.balance_kobo, 0);
    const membersKobo = totals[c.key];
    return { label: c.label, account_codes: c.codes, accounts, gl_kobo: glKobo, members_kobo: membersKobo, unallocated_kobo: glKobo - membersKobo };
  });

  return {
    type, title: cfg.title, as_of: asOf, columns: cfg.columns, rows, totals, reconciliation,
    reconciled: reconciliation.every(r => r.unallocated_kobo === 0),
    unresolved_member_records: orphanTotal > 0,
  };
}


// ------------------------------------------------------------- member detail
const SOURCE_LABELS = { interest_credit: 'Interest credited', dividend_credit: 'Dividend credited', cash_in_person: 'Cash payment',
  bank_transfer_manual: 'Bank transfer', flutterwave_checkout: 'Online payment (Flutterwave)', flutterwave_webhook: 'Bank transfer (auto-detected)' };
const srcLabel = s => SOURCE_LABELS[s] || String(s || 'Payment').replace(/_/g, ' ');

const DETAIL_KEYS = {
  savings: [{ key: 'balance', label: 'Balance' }],
  loans: [{ key: 'principal_outstanding', label: 'Principal' }, { key: 'interest_outstanding', label: 'Interest' }],
  dues: [{ key: 'balance', label: 'Outstanding' }],
  investments: [{ key: 'balance', label: 'Balance owed' }],
  shares: [{ key: 'share_capital', label: 'Share capital' }, { key: 'dividends_payable', label: 'Dividends payable' }],
};

/** Every movement behind one member's figure, in date order with running balances. */
async function computeSubledgerDetail(db, coopId, type, memberId, asOf = null) {
  if (!SUBLEDGERS[type]) return null;
  const { data: member } = await db.from('coop_members').select('id, name, phone_normalized, activated_at, opening_balance_kobo').eq('coop_id', coopId).eq('id', memberId).maybeSingle();
  if (!member) return null;
  const cutoff = asOf ? `${asOf}T23:59:59.999Z` : null;
  const asOfDate = asOf ? new Date(`${asOf}T12:00:00Z`) : new Date();
  const upTo = (q, col) => (cutoff ? q.lte(col, cutoff) : q);
  const events = [];   // { date, description, deltas: { key: kobo } }

  if (type === 'savings') {
    if (num(member.opening_balance_kobo)) events.push({ date: member.activated_at || '1970-01-01T00:00:00Z', description: 'Opening balance (recorded when the member was activated)', deltas: { balance: num(member.opening_balance_kobo) } });
    const txns = await fetchAllRows(() => upTo(db.from('coop_savings_transactions').select('id, amount_kobo, source, reference, recorded_at').eq('coop_id', coopId).eq('member_id', memberId).order('id'), 'recorded_at'));
    for (const t of txns) events.push({ date: t.recorded_at, description: srcLabel(t.source) + (t.reference && t.source !== 'interest_credit' ? ` — ${t.reference}` : ''), deltas: { balance: num(t.amount_kobo) } });
  }
  if (type === 'loans') {
    const loans = await fetchAllRows(() => upTo(db.from('coop_loans').select('id, principal_kobo, interest_kobo, disbursed_at').eq('coop_id', coopId).eq('member_id', memberId).not('disbursed_at', 'is', null).order('id'), 'disbursed_at'));
    for (const l of loans) events.push({ date: l.disbursed_at, description: 'Loan disbursed', deltas: { principal_outstanding: num(l.principal_kobo), interest_outstanding: num(l.interest_kobo) } });
    for (const ids of chunk(loans.map(l => l.id))) {
      const reps = await fetchAllRows(() => upTo(db.from('coop_loan_repayments').select('id, source, principal_portion_kobo, interest_portion_kobo, recorded_at').in('loan_id', ids).order('id'), 'recorded_at'));
      for (const r of reps) events.push({ date: r.recorded_at, description: `Repayment — ${srcLabel(r.source)}`, deltas: { principal_outstanding: -num(r.principal_portion_kobo), interest_outstanding: -num(r.interest_portion_kobo) } });
    }
  }
  if (type === 'dues') {
    const { data: society } = await db.from('coop_societies').select('dues_amount_kobo').eq('coop_id', coopId).maybeSingle();
    const rate = num(society && society.dues_amount_kobo);
    if (rate > 0 && member.activated_at) {
      for (const y of calculateDuesScheduleByYear(member.activated_at, asOfDate)) if (y.months_owed > 0) events.push({ date: `${y.year}-01-01T00:00:00Z`, description: `Dues for ${y.year} (${y.months_owed} month${y.months_owed === 1 ? '' : 's'})`, deltas: { balance: y.months_owed * rate } });
      const pays = await fetchAllRows(() => upTo(db.from('coop_dues_transactions').select('id, amount_kobo, source, recorded_at').eq('coop_id', coopId).eq('member_id', memberId).order('id'), 'recorded_at'));
      for (const t of pays) events.push({ date: t.recorded_at, description: `Payment — ${srcLabel(t.source)}`, deltas: { balance: -num(t.amount_kobo) } });
    }
  }
  if (type === 'investments') {
    const invs = await fetchAllRows(() => upTo(db.from('coop_member_investments').select('id, principal_kobo, units_purchased, purchased_at, withdrawn_at, coop_investment_products(name)').eq('coop_id', coopId).eq('member_id', memberId).order('id'), 'purchased_at'));
    for (const i of invs) {
      const name = (i.coop_investment_products && i.coop_investment_products.name) || 'Investment';
      const accs = await fetchAllRows(() => upTo(db.from('coop_investment_accruals').select('id, amount_kobo, accrued_at').eq('member_investment_id', i.id).order('id'), 'accrued_at'));
      const accrued = accs.reduce((s, a) => s + num(a.amount_kobo), 0);
      events.push({ date: i.purchased_at, description: `${name} — ${i.units_purchased} unit(s) purchased`, deltas: { balance: num(i.principal_kobo) } });
      for (const a of accs) events.push({ date: a.accrued_at, description: `${name} — return accrued`, deltas: { balance: num(a.amount_kobo) } });
      if (i.withdrawn_at && (!cutoff || i.withdrawn_at <= cutoff)) events.push({ date: i.withdrawn_at, description: `${name} — paid out`, deltas: { balance: -(num(i.principal_kobo) + accrued) } });
    }
  }
  if (type === 'shares') {
    const st = await fetchAllRows(() => upTo(db.from('coop_share_transactions').select('id, amount_kobo, source, reference, recorded_at').eq('coop_id', coopId).eq('member_id', memberId).order('id'), 'recorded_at'));
    for (const t of st) events.push({ date: t.recorded_at, description: `Share capital — ${srcLabel(t.source)}`, deltas: { share_capital: num(t.amount_kobo) } });
    const runs = await fetchAllRows(() => upTo(db.from('coop_dividend_runs').select('id, approved_at').eq('coop_id', coopId).eq('payable_booked', true).order('id'), 'approved_at'));
    const runDate = new Map(runs.map(r => [r.id, r.approved_at]));
    for (const ids of chunk(runs.map(r => r.id))) {
      const ents = await fetchAllRows(() => db.from('coop_dividend_entitlements').select('id, dividend_run_id, entitlement_kobo').eq('member_id', memberId).in('dividend_run_id', ids).order('id'));
      for (const e of ents) events.push({ date: runDate.get(e.dividend_run_id), description: 'Dividend declared', deltas: { dividends_payable: num(e.entitlement_kobo) } });
      for (const eids of chunk(ents.map(e => e.id))) {
        const pays = await fetchAllRows(() => upTo(db.from('coop_dividend_payouts').select('id, method, amount_kobo, completed_at').in('entitlement_id', eids).eq('status', 'completed').order('id'), 'completed_at'));
        for (const p of pays) events.push({ date: p.completed_at, description: `Dividend paid out (${p.method})`, deltas: { dividends_payable: -num(p.amount_kobo) } });
      }
    }
  }

  events.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const keys = DETAIL_KEYS[type];
  const running = Object.fromEntries(keys.map(k => [k.key, 0]));
  const rows = events.map(e => {
    const balances = {};
    for (const k of keys) { running[k.key] += e.deltas[k.key] || 0; balances[k.key] = running[k.key]; }
    return { date: e.date, description: e.description, deltas: e.deltas, balances };
  });
  return { type, title: SUBLEDGERS[type].title, member: { id: member.id, name: member.name, phone_normalized: member.phone_normalized }, as_of: asOf, keys, rows, totals: { ...running } };
}

module.exports = { computeSubledger, computeSubledgerDetail, membersWithoutSavingsPlan, SUBLEDGERS, SUBLEDGER_TYPES: Object.keys(SUBLEDGERS) };
