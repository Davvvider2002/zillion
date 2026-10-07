/**
 * zillion/backend/lib/coopBankGroupMatch.js
 *
 * Grouped bank-statement matching: ONE bank line explained by SEVERAL records - a batch deposit made up of several receipts, a single
 * payment that settles several items. Automatic matching is deliberately one-to-one and exact (silently adding things up could hide a
 * real discrepancy), so a many-to-one match is always a PERSON's decision. What makes it safe to offer:
 *
 *   - the server decides what can be grouped: it reloads the genuine candidates for THAT bank line and refuses anything else, so a
 *     browser cannot invent, or smuggle in, a record;
 *   - the selected records must add up to the bank line EXACTLY, to the kobo, and all point the same way (money in / money out);
 *   - a record explains at most one thing per statement upload - checked here, and enforced by a unique index in the database;
 *   - the line is claimed atomically ("unmatched" -> "matched" only if still unmatched), so two people cannot both confirm it;
 *   - it is reversible: an undo restores the line and the "recorded but not on the statement" items the group had consumed;
 *   - every component keeps a snapshot of what it was, and who confirmed the group and when.
 *
 * Suggestions (suggestGroups) only SAVE EFFORT - they find combinations that add up exactly. They never match anything themselves.
 */
'use strict';

const { fetchAllRows, chunk } = require('./coopPaginate');
const { fetchReconcilableRecords, DATE_TOLERANCE_DAYS } = require('./coopBankReconciliation');
const { isSettlementAccount } = require('./coopBankAccountInfo');
const { accountingIsReady } = require('./coopAccountingHelpers');

const GROUP_DATE_WINDOW_DAYS = 14;     // a group's records may be up to this far from the bank line (bank batches lag, entries are made late)
const MAX_COMPONENTS = 30;
const keyOf = (type, id) => `${type}:${id}`;
const day = d => String(d).slice(0, 10);
const shiftDay = (d, n) => new Date(new Date(day(d) + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
const daysApart = (a, b) => Math.abs((new Date(day(a) + 'T00:00:00Z') - new Date(day(b) + 'T00:00:00Z')) / 86400000);
const fail = (status, error) => ({ ok: false, status, error });
const naira = k => '₦' + (k / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The statement line, its upload, and the bank account (from the chart of accounts) the upload was for. */
async function loadLineContext(db, coopId, lineId) {
  const { data: line } = await db.from('coop_bank_statement_lines')
    .select('id, batch_id, coop_id, statement_date, description, amount_kobo, matched_type, matched_id, match_status, direction').eq('id', lineId).eq('coop_id', coopId).maybeSingle();
  if (!line) return null;
  const { data: batch } = await db.from('coop_bank_reconciliation_batches').select('id, bank_account_id, bank_name').eq('id', line.batch_id).eq('coop_id', coopId).maybeSingle();
  let account = null;
  if (batch && batch.bank_account_id) ({ data: account } = await db.from('coop_chart_of_accounts').select('id, account_code, account_name').eq('id', batch.bank_account_id).maybeSingle());
  return { line, batch, account };
}

/** Records already explaining something in this statement upload: automatic matches, and components of other groups. */
async function usedKeys(db, batchId) {
  const used = new Set();
  for (const l of await fetchAllRows(() => db.from('coop_bank_statement_lines').select('matched_type, matched_id').eq('batch_id', batchId).not('matched_id', 'is', null).order('id'))) used.add(keyOf(l.matched_type, l.matched_id));
  for (const m of await fetchAllRows(() => db.from('coop_bank_statement_line_matches').select('component_type, component_id').eq('batch_id', batchId).order('id'))) used.add(keyOf(m.component_type, m.component_id));
  return used;
}

/**
 * Everything that COULD be part of a group for this bank line: genuine candidates for this bank account (loans, Flutterwave money, and -
 * with accounting set up - anything the books recorded on the account), not already used in this upload, pointing the same way, and
 * within the window. Nearest in time first.
 */
async function loadGroupCandidates(db, coopId, ctx) {
  const { line, account } = ctx;
  const { data: soc } = await db.from('coop_societies').select('settlement_account_code').eq('coop_id', coopId).maybeSingle();
  const window = { from: shiftDay(line.statement_date, -GROUP_DATE_WINDOW_DAYS), to: shiftDay(line.statement_date, GROUP_DATE_WINDOW_DAYS) };
  const flw = !!(account && isSettlementAccount(soc, account.account_code));
  const books = !!(account && await accountingIsReady(db, coopId));
  const records = await fetchReconcilableRecords(db, coopId, { flutterwave: flw ? window : null, books: books ? { accountCode: account.account_code, ...window } : null });
  const used = await usedKeys(db, line.batch_id);
  const wanted = line.direction;
  return records
    .map(c => ({ ...c, direction: c.direction || (c.type === 'loan_repayment' ? 'credit' : 'debit') }))        // a repayment is money IN, a disbursement money OUT
    .filter(c => c.direction === wanted && c.amountKobo > 0 && daysApart(c.date, line.statement_date) <= GROUP_DATE_WINDOW_DAYS && !used.has(keyOf(c.type, c.id)))
    .sort((a, b) => daysApart(a.date, line.statement_date) - daysApart(b.date, line.statement_date) || b.amountKobo - a.amountKobo);
}

/**
 * Combinations of candidates that add up EXACTLY to the target. Bounded (a pool of the nearest ~22 candidates, groups of at most 8, a
 * fixed search budget) so it can never hang a request. Fewest records first, then the tightest spread of dates.
 */
function suggestGroups(target, candidates, { maxSize = 8, nodeBudget = 80000, pool = 22, limit = 5 } = {}) {
  const items = candidates.filter(c => c.amountKobo <= target).slice(0, pool);
  const order = [...items].sort((a, b) => b.amountKobo - a.amountKobo);
  const suffix = new Array(order.length + 1).fill(0);
  for (let i = order.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + order[i].amountKobo;
  const found = []; let nodes = 0;
  const walk = (i, remaining, chosen) => {
    if (found.length >= 40 || nodes++ > nodeBudget) return;
    if (remaining === 0) { found.push([...chosen]); return; }
    if (i >= order.length || chosen.length >= maxSize || suffix[i] < remaining) return;
    const c = order[i];
    if (c.amountKobo <= remaining) { chosen.push(c); walk(i + 1, remaining - c.amountKobo, chosen); chosen.pop(); }
    walk(i + 1, remaining, chosen);
  };
  walk(0, target, []);
  const spread = g => { const t = g.map(c => new Date(day(c.date)).getTime()); return (Math.max(...t) - Math.min(...t)) / 86400000; };
  return found.sort((a, b) => a.length - b.length || spread(a) - spread(b)).slice(0, limit).map(g => g.map(c => ({ type: c.type, id: c.id })));
}

/** Confirms a group. `components` = [{ type, id }]. Nothing is written unless EVERY check passes. */
async function confirmGroup(db, actor, { coopId, lineId, components }) {
  if (!Array.isArray(components) || !components.length) return fail(400, 'Choose at least one record to match this bank line to');
  if (components.length > MAX_COMPONENTS) return fail(400, `A group can have at most ${MAX_COMPONENTS} records`);
  const keys = components.map(c => keyOf(c && c.type, c && c.id));
  if (components.some(c => !c || typeof c.type !== 'string' || typeof c.id !== 'string' || !c.type || !c.id)) return fail(400, 'Every record needs a type and an id');
  if (new Set(keys).size !== keys.length) return fail(400, 'The same record was chosen twice');

  const ctx = await loadLineContext(db, coopId, lineId);
  if (!ctx) return fail(404, 'Statement line not found in your society');
  const { line, batch } = ctx;
  if (line.match_status !== 'unmatched') return fail(409, 'This bank line is already matched');

  const available = new Map((await loadGroupCandidates(db, coopId, ctx)).map(c => [keyOf(c.type, c.id), c]));
  const chosen = [];
  for (const k of keys) {
    const c = available.get(k);
    if (!c) return fail(409, 'One of the chosen records is not available for this bank line (it may already be matched, point the other way, be too far in time, or not belong to this bank account)');
    chosen.push(c);
  }
  const total = chosen.reduce((t, c) => t + c.amountKobo, 0);
  if (total !== line.amount_kobo) {
    return fail(400, `The chosen records add up to ${naira(total)}, but the bank line is ${naira(line.amount_kobo)} (${total > line.amount_kobo ? 'over' : 'short'} by ${naira(Math.abs(total - line.amount_kobo))}). They must match exactly.`);
  }

  // claim the line: only one person can turn it from unmatched to matched
  const { data: claimed } = await db.from('coop_bank_statement_lines').update({ match_status: 'matched', matched_type: 'group', matched_id: null })
    .eq('id', line.id).eq('coop_id', coopId).eq('match_status', 'unmatched').select('id');
  if (!(Array.isArray(claimed) ? claimed.length : claimed)) return fail(409, 'This bank line was just matched by someone else');

  const { error: linkErr } = await db.from('coop_bank_statement_line_matches').insert(chosen.map(c => ({
    coop_id: coopId, statement_line_id: line.id, batch_id: line.batch_id, component_type: c.type, component_id: c.id, amount_kobo: c.amountKobo,
    record_date: day(c.date), description: c.description || null, matched_by: actor.id,
  })));
  if (linkErr) {           // undo the claim: leave the line exactly as it was
    await db.from('coop_bank_statement_line_matches').delete().eq('statement_line_id', line.id);
    await db.from('coop_bank_statement_lines').update({ match_status: 'unmatched', matched_type: null, matched_id: null }).eq('id', line.id);
    return linkErr.code === '23505' ? fail(409, 'One of those records was just used by another match') : fail(500, `Could not save the match: ${linkErr.message}`);
  }
  await settleBatchBookkeeping(db, coopId, line.batch_id, chosen, 'remove');
  return { ok: true, line_id: line.id, total_kobo: total, components: chosen.map(c => ({ type: c.type, id: c.id, amount_kobo: c.amountKobo, date: day(c.date), description: c.description })), batch_id: batch && batch.id };
}

/** Undoes a group: the line goes back to unmatched, and what the group consumed is "recorded but not on the statement" again. */
async function unmatchGroup(db, actor, { coopId, lineId }) {
  const ctx = await loadLineContext(db, coopId, lineId);
  if (!ctx) return fail(404, 'Statement line not found in your society');
  if (ctx.line.matched_type !== 'group') return fail(409, 'This bank line is not matched as a group');
  const comps = await fetchAllRows(() => db.from('coop_bank_statement_line_matches').select('*').eq('statement_line_id', ctx.line.id).order('id'));
  const { data: released } = await db.from('coop_bank_statement_lines').update({ match_status: 'unmatched', matched_type: null, matched_id: null })
    .eq('id', ctx.line.id).eq('coop_id', coopId).eq('matched_type', 'group').select('id');
  if (!(Array.isArray(released) ? released.length : released)) return fail(409, 'This match was just undone by someone else');
  await db.from('coop_bank_statement_line_matches').delete().eq('statement_line_id', ctx.line.id);
  await settleBatchBookkeeping(db, coopId, ctx.line.batch_id, comps.map(m => ({ type: m.component_type, id: m.component_id, amountKobo: m.amount_kobo, date: m.record_date, description: m.description })), 'restore');
  return { ok: true, line_id: ctx.line.id, released: comps.length };
}

/**
 * Keeps the upload's own numbers honest: the matched count, and the "recorded but not found in the statement" list - records a group
 * consumed leave it, and return to it (if they should be reported) when the group is undone.
 */
async function settleBatchBookkeeping(db, coopId, batchId, components, mode) {
  const byType = new Map();
  for (const c of components) { if (!byType.has(c.type)) byType.set(c.type, []); byType.get(c.type).push(c); }
  if (mode === 'remove') {
    for (const [type, list] of byType) for (const ids of chunk(list.map(c => c.id))) await db.from('coop_reconciliation_unmatched_records').delete().eq('batch_id', batchId).eq('record_type', type).in('record_id', ids);
  } else {
    // only what the statement should have shown (inside it, and not in its last days) - the same rule as the original report
    const dates = (await fetchAllRows(() => db.from('coop_bank_statement_lines').select('statement_date').eq('batch_id', batchId).order('id'))).map(l => day(l.statement_date)).sort();
    const from = dates[0], reportUntil = dates.length ? shiftDay(dates[dates.length - 1], -DATE_TOLERANCE_DAYS) : null;
    const back = components.filter(c => from && c.date && day(c.date) >= from && day(c.date) <= reportUntil);
    if (back.length) await db.from('coop_reconciliation_unmatched_records').insert(back.map(c => ({ batch_id: batchId, coop_id: coopId, record_type: c.type, record_id: c.id, record_date: day(c.date), amount_kobo: c.amountKobo, description: c.description || null })));
  }
  const { count } = await db.from('coop_bank_statement_lines').select('id', { count: 'exact', head: true }).eq('batch_id', batchId).eq('match_status', 'matched');
  await db.from('coop_bank_reconciliation_batches').update({ matched_lines: count || 0 }).eq('id', batchId);
}

module.exports = { loadLineContext, loadGroupCandidates, suggestGroups, confirmGroup, unmatchGroup, GROUP_DATE_WINDOW_DAYS, MAX_COMPONENTS };
