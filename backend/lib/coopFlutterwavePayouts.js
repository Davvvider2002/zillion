/**
 * zillion/backend/lib/coopFlutterwavePayouts.js
 *
 * Paying societies the money Zillion holds on their behalf.
 *
 * Bank transfers into a member's virtual account land in ZILLION's Flutterwave balance (no split to the society's sub-account),
 * so they never appear in the society's own settlements and must be paid on. This is the engine that does it - automatically,
 * but only after people approve it.
 *
 *   PENDING_APPROVAL --approve (x1, or x2 for large amounts)--> APPROVED --execute--> PROCESSING --Flutterwave confirms--> PAID
 *        |                                                         |                      |
 *        +--reject / cancel--> REJECTED / CANCELLED                +--(rejected by Flutterwave: stays APPROVED, retryable)
 *                                                                                         +--FAILED (rows released)
 *
 * SAFETY, in the order it matters:
 *  1. Nothing moves unless ZILLION_PAYOUTS_ENABLED=true AND a live Flutterwave key is configured. Off by default.
 *  2. Maker-checker: whoever prepared a payout can never approve it; large payouts need two different approvers (and
 *     the endpoint demands a fresh authenticator code for each).
 *  3. Every state change is an atomic "claim" (UPDATE ... WHERE status = <expected>): two people or two scheduler runs can
 *     never both act on the same payout, and the unique transfer reference means Flutterwave itself refuses a second send.
 *  4. The ledger rows being paid are RESERVED to the payout (so they cannot be in two), and are re-checked right before sending.
 *  5. The destination is snapshotted when prepared and its account name verified with the bank; if the society's account changes
 *     before sending, the payout is stopped.
 *  6. If we cannot tell whether a transfer was created (timeout, unreadable reply), it is NEVER retried automatically: it is
 *     flagged for a person to check with Flutterwave first. A double payment is worse than a delayed one.
 *  7. Caps: a minimum, a per-payout maximum and a rolling 24-hour limit.
 *  8. Every step is written to an audit trail (who, when, what), and the books on both sides are posted on confirmation.
 */
'use strict';

const { fetchAllRows, chunk } = require('./coopPaginate');
const { logAlert } = require('./alerts');
const { accountingIsReady, getAccounts, postEntryLines } = require('./coopAccountingHelpers');
const zl = require('./zillionLedgerHelpers');
const { FLW_CLEARING_CODE, BANK_CODE } = require('./coopFlutterwaveAccounts');
const { isLiveKey } = require('./coopFlutterwaveLedger');

const FLW = 'https://api.flutterwave.com/v3';
const APPROVER_ROLES = ['SUPER_ADMIN', 'COMPLIANCE'];
const PREPARER_ROLES = ['SUPER_ADMIN', 'OPERATIONS'];
const SYSTEM_ACTOR = { id: 'system:scheduler', name: 'Scheduler', role: 'SYSTEM' };
const ZILLION_BANK = '1000', ZILLION_OWED = '2000', ZILLION_FEES = '5100';
const ACTIVE = ['PENDING_APPROVAL', 'APPROVED', 'PROCESSING'];
const SOURCE = 'coopFlutterwavePayouts';
const toKobo = n => Math.round(Number(n) * 100);
const naira = k => '₦' + (k / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function config(env = process.env) {
  const n = (k, d) => { const v = Number(env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
  return {
    enabled: env.ZILLION_PAYOUTS_ENABLED === 'true',                       // OFF unless explicitly switched on
    dualApprovalKobo: n('PAYOUT_DUAL_APPROVAL_KOBO', 100000000),           // N1,000,000: at or above this, two approvers
    minKobo: n('PAYOUT_MIN_KOBO', 100000),                                 // N1,000: not worth a transfer fee below this
    maxKobo: n('PAYOUT_MAX_KOBO', 500000000),                              // N5,000,000 per payout
    dailyLimitKobo: n('PAYOUT_DAILY_LIMIT_KOBO', 1000000000),              // N10,000,000 in any rolling 24 hours
    minAgeHours: n('PAYOUT_MIN_AGE_HOURS', 24),                            // the scheduler proposes receipts at least this old
  };
}

// ── small helpers ────────────────────────────────────────────────────────────────────────────────────────────────────
const rowsOf = data => Array.isArray(data) ? data : (data ? [data] : []);

/** Atomically moves a payout from one of `from` statuses to `patch.status`. Returns the updated row, or null if someone else got there first. */
async function claim(db, id, from, patch, extra = {}) {
  let q = db.from('coop_flutterwave_payouts').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).in('status', from);
  for (const [k, v] of Object.entries(extra)) q = q.eq(k, v);
  const { data, error } = await q.select('*');
  if (error) throw new Error(error.message);
  return rowsOf(data)[0] || null;
}
async function getPayout(db, id) { const { data } = await db.from('coop_flutterwave_payouts').select('*').eq('id', id).maybeSingle(); return data || null; }
async function logEvent(db, p, event, actor, note) {
  await db.from('coop_flutterwave_payout_events').insert({ payout_id: p.id, coop_id: p.coop_id, event, actor: actor.id, actor_name: actor.name || null, note: note || null }).then(() => {}, () => {});
}
async function eventsOf(db, id) { return fetchAllRows(() => db.from('coop_flutterwave_payout_events').select('*').eq('payout_id', id).order('created_at').order('id')); }
async function releaseRows(db, payoutId) { await db.from('coop_flutterwave_ledger').update({ payout_id: null }).eq('payout_id', payoutId).is('settled_in', null); }
const fail = (status, error) => ({ ok: false, status, error });

// ── checking the destination ─────────────────────────────────────────────────────────────────────────────────────────
const NOISE = new Set(['LTD', 'LIMITED', 'COOP', 'COOPERATIVE', 'CO', 'OPERATIVE', 'SOCIETY', 'MULTIPURPOSE', 'MULTI', 'PURPOSE', 'THRIFT', 'CREDIT', 'UNION', 'ASSOCIATION', 'AND', 'THE', 'OF', 'PLC', 'NIGERIA', 'NIG', 'ENTERPRISES', 'ENT']);
const tokens = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').split(' ').filter(t => t.length > 1 && !NOISE.has(t));
/** Does the name the bank gives broadly match the name on file? Needs at least half of the shorter name's meaningful words to appear in the other. */
function namesMatch(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.length || !B.length) return String(a || '').trim().toUpperCase() === String(b || '').trim().toUpperCase() && !!String(a || '').trim();
  const setB = new Set(B), common = A.filter(t => setB.has(t)).length;
  return common >= Math.max(1, Math.ceil(Math.min(A.length, B.length) * 0.5));
}
async function resolveAccountName(fetchImpl, secretKey, bankCode, accountNumber) {
  try {
    const res = await fetchImpl(`${FLW}/accounts/resolve`, { method: 'POST', headers: { Authorization: `Bearer ${String(secretKey).trim()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ account_number: accountNumber, account_bank: bankCode }) });
    const j = await res.json();
    return (j && j.status === 'success' && j.data && j.data.account_name) ? String(j.data.account_name) : null;
  } catch (e) { return null; }
}

// ── preparing ──────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Groups a society's owed bank-transfer receipts into ONE payout awaiting approval. Reserves the rows, snapshots and verifies
 * the destination. `minAgeHours` (the scheduler) only includes receipts at least that old.
 */
async function preparePayout(db, actor, coopId, { cfg = config(), now = new Date(), fetchImpl = fetch, secretKey = process.env.FLW_V3_SECRET_KEY, minAgeHours = 0 } = {}) {
  if (actor.role !== 'SYSTEM' && !PREPARER_ROLES.includes(actor.role)) return fail(403, 'Only SUPER_ADMIN or OPERATIONS can prepare a payout');
  const { data: society } = await db.from('coop_societies').select('coop_id, name, settlement_bank_code, settlement_account_number, settlement_account_name, settlement_account_code').eq('coop_id', coopId).maybeSingle();
  if (!society) return fail(404, 'Society not found');
  if (!society.settlement_bank_code || !society.settlement_account_number) return fail(400, `${society.name} has no settlement bank account on file, so there is nowhere to pay it`);

  const { data: active } = await db.from('coop_flutterwave_payouts').select('id, status').eq('coop_id', coopId).in('status', ACTIVE).limit(1);
  if (active && active.length) return fail(409, `${society.name} already has a payout in progress (${active[0].status})`);

  const cutoff = new Date(now.getTime() - minAgeHours * 3600000).toISOString();
  let rows = await fetchAllRows(() => db.from('coop_flutterwave_ledger').select('id, amount_kobo, occurred_at').eq('coop_id', coopId)
    .eq('entry_type', 'PAYMENT').eq('live_mode', true).eq('channel', 'virtual_account').is('settled_in', null).is('payout_id', null).lte('occurred_at', cutoff).order('occurred_at').order('id'));
  const picked = []; let total = 0;
  for (const r of rows) { if (total + r.amount_kobo > cfg.maxKobo) break; picked.push(r); total += r.amount_kobo; }       // oldest first, up to the per-payout maximum
  if (!picked.length) return fail(400, rows.length ? `The oldest receipt alone is above the ${naira(cfg.maxKobo)} per-payout limit - pay it manually` : `${society.name} has no owed bank-transfer receipts to pay out`);
  if (total < cfg.minKobo) return fail(400, `${naira(total)} is below the ${naira(cfg.minKobo)} minimum payout`);

  const resolved = await resolveAccountName(fetchImpl, secretKey, society.settlement_bank_code, society.settlement_account_number);
  const nameCheck = resolved ? (namesMatch(resolved, society.settlement_account_name) ? 'MATCH' : 'MISMATCH') : 'UNVERIFIED';
  const ref = `ZPO-${now.getTime().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  const { data: payout, error } = await db.from('coop_flutterwave_payouts').insert({
    payout_ref: ref, coop_id: coopId, status: 'PENDING_APPROVAL', amount_kobo: total, item_count: picked.length,
    approvals_required: total >= cfg.dualApprovalKobo ? 2 : 1,
    dest_bank_code: society.settlement_bank_code, dest_account_number: society.settlement_account_number, dest_account_name: society.settlement_account_name || null,
    resolved_account_name: resolved, name_check: nameCheck, settlement_account_code: society.settlement_account_code || null,
    requested_by: actor.id, requested_by_name: actor.name || null, requested_at: now.toISOString(),
  }).select('*').single();
  if (error) return error.code === '23505' ? fail(409, `${society.name} already has a payout in progress`) : fail(500, `Could not create the payout: ${error.message}`);

  // reserve the rows: either ALL of them are ours or none are
  let reserved = 0;
  for (const ids of chunk(picked.map(r => r.id))) {
    const { data } = await db.from('coop_flutterwave_ledger').update({ payout_id: payout.id }).in('id', ids).is('payout_id', null).is('settled_in', null).select('id');
    reserved += rowsOf(data).length;
  }
  if (reserved !== picked.length) {
    await releaseRows(db, payout.id);
    await db.from('coop_flutterwave_payouts').delete().eq('id', payout.id);
    return fail(409, 'Those receipts changed while the payout was being prepared - please try again');
  }
  await logEvent(db, payout, 'PREPARED', actor, `${naira(total)} across ${picked.length} receipt(s); name check ${nameCheck}${resolved ? ` (bank says "${resolved}")` : ''}; needs ${payout.approvals_required} approval(s)`);
  await logAlert(db, { severity: 'INFO', source: SOURCE, message: `Payout of ${naira(total)} to ${society.name} is awaiting approval (${payout.approvals_required} approver(s) needed; account name ${nameCheck.toLowerCase()})`, context: { payout_id: payout.id, coop_id: coopId } }).catch(() => {});
  return { ok: true, payout };
}

// ── approving, rejecting, cancelling ───────────────────────────────────────────────────────────────────────────────────
async function approvePayout(db, actor, payoutId, { acknowledgeDestination = false, ...opts } = {}) {
  if (!APPROVER_ROLES.includes(actor.role)) return fail(403, 'Only SUPER_ADMIN or COMPLIANCE can approve a payout');
  const p = await getPayout(db, payoutId);
  if (!p) return fail(404, 'Payout not found');
  if (p.status !== 'PENDING_APPROVAL') return fail(409, `This payout is ${p.status}, not awaiting approval`);
  if (p.requested_by === actor.id) return fail(403, 'You prepared this payout, so someone else must approve it');
  const events = await eventsOf(db, p.id);
  if (events.some(e => e.event === 'APPROVED' && e.actor === actor.id)) return fail(409, 'You have already approved this payout - a different approver is needed');
  if (p.name_check !== 'MATCH' && !acknowledgeDestination) {
    return fail(400, p.name_check === 'MISMATCH'
      ? `The bank says this account is "${p.resolved_account_name}", which does not match "${p.dest_account_name}" on file. Approve only if you have confirmed it is correct, and tick the acknowledgement.`
      : 'The account name could not be verified with the bank. Approve only if you have confirmed the details independently, and tick the acknowledgement.');
  }
  await logEvent(db, p, 'APPROVED', actor, p.name_check !== 'MATCH' ? `approved with destination acknowledged (name check ${p.name_check})` : null);
  const approvals = events.filter(e => e.event === 'APPROVED').length + 1;
  if (approvals < p.approvals_required) return { ok: true, payout: await getPayout(db, p.id), approvals, required: p.approvals_required, executed: null };

  const approved = await claim(db, p.id, ['PENDING_APPROVAL'], { status: 'APPROVED' });
  if (approved) await logEvent(db, p, 'FULLY_APPROVED', actor, `${approvals} of ${p.approvals_required} approvals`);
  let executed = null;
  if (approved && (opts.cfg || config()).enabled) executed = await executePayout(db, p.id, opts).catch(e => ({ error: e.message }));
  return { ok: true, payout: await getPayout(db, p.id), approvals, required: p.approvals_required, executed };
}

async function endPayout(db, actor, payoutId, { status, event, from, note, allow }) {
  const p = await getPayout(db, payoutId);
  if (!p) return fail(404, 'Payout not found');
  if (!allow(p)) return fail(403, 'You are not allowed to do that to this payout');
  const done = await claim(db, p.id, from, { status, failure_reason: note || null });
  if (!done) return fail(409, `This payout is ${p.status} and can no longer be ${event.toLowerCase()}`);
  await releaseRows(db, p.id);
  await logEvent(db, p, event, actor, note);
  return { ok: true, payout: done };
}
const rejectPayout = (db, actor, id, reason) => endPayout(db, actor, id, { status: 'REJECTED', event: 'REJECTED', from: ['PENDING_APPROVAL', 'APPROVED'], note: reason || 'rejected', allow: () => APPROVER_ROLES.includes(actor.role) });
const cancelPayout = (db, actor, id) => endPayout(db, actor, id, { status: 'CANCELLED', event: 'CANCELLED', from: ['PENDING_APPROVAL', 'APPROVED'], note: 'cancelled', allow: p => p.requested_by === actor.id || actor.role === 'SUPER_ADMIN' });

// ── executing ──────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Money is sent here and only here. Returns what happened; never throws on a Flutterwave problem. */
async function executePayout(db, payoutId, { cfg = config(), fetchImpl = fetch, secretKey = process.env.FLW_V3_SECRET_KEY, now = new Date() } = {}) {
  if (!cfg.enabled) return { skipped: 'automatic payouts are switched off (ZILLION_PAYOUTS_ENABLED is not "true")' };
  if (!isLiveKey(secretKey)) return { skipped: 'no live Flutterwave key is configured' };
  const system = SYSTEM_ACTOR;

  const p = await claim(db, payoutId, ['APPROVED'], { status: 'PROCESSING', execution: 'AUTOMATIC', failure_reason: null }, { needs_verification: false });
  if (!p) return { skipped: 'not in a state to send (already sent, not approved, or awaiting verification)' };
  await db.from('coop_flutterwave_payouts').update({ attempts: (p.attempts || 0) + 1 }).eq('id', p.id);
  const revert = async (reason, evt = 'EXECUTION_FAILED') => {            // a definite "no": back to APPROVED, still reserved, retryable
    await claim(db, p.id, ['PROCESSING'], { status: 'APPROVED', failure_reason: reason });
    await logEvent(db, p, evt, system, reason);
    await logAlert(db, { severity: 'WARNING', source: SOURCE, message: `Payout ${p.payout_ref} (${naira(p.amount_kobo)}) could not be sent: ${reason}`, context: { payout_id: p.id, coop_id: p.coop_id }, dedupeHours: 12 }).catch(() => {});
    return { failed: true, reason };
  };
  const stop = async reason => { await failPayout(db, p, reason, ['PROCESSING']); return { stopped: true, reason }; };

  // 1. the destination must still be what the approvers saw
  const { data: soc } = await db.from('coop_societies').select('name, settlement_bank_code, settlement_account_number').eq('coop_id', p.coop_id).maybeSingle();
  if (!soc || soc.settlement_bank_code !== p.dest_bank_code || soc.settlement_account_number !== p.dest_account_number) return stop('The society\'s settlement account changed after approval - prepare a new payout so it can be approved again');
  // 2. the rows must still be exactly what was approved
  const held = await fetchAllRows(() => db.from('coop_flutterwave_ledger').select('id, amount_kobo, settled_in').eq('payout_id', p.id).order('id'));
  if (held.length !== p.item_count || held.some(r => r.settled_in) || held.reduce((t, r) => t + r.amount_kobo, 0) !== p.amount_kobo) return stop('The receipts reserved for this payout no longer match what was approved');
  // 3. the rolling daily limit
  const since = new Date(now.getTime() - 86400000).toISOString();
  const recent = await fetchAllRows(() => db.from('coop_flutterwave_payouts').select('id, amount_kobo').in('status', ['PROCESSING', 'PAID']).gte('updated_at', since).order('id'));
  const sentToday = recent.filter(r => r.id !== p.id).reduce((t, r) => t + r.amount_kobo, 0);
  if (sentToday + p.amount_kobo > cfg.dailyLimitKobo) return revert(`This would take today's payouts past the ${naira(cfg.dailyLimitKobo)} daily limit (${naira(sentToday)} already sent) - it will be retried`, 'DAILY_LIMIT');
  // 4. best-effort balance check (Flutterwave itself refuses an overdraft; this just fails early and clearly)
  const headers = { Authorization: `Bearer ${String(secretKey).trim()}`, 'Content-Type': 'application/json' };
  try {
    const b = await (await fetchImpl(`${FLW}/balances/NGN`, { headers })).json();
    const avail = b && b.data && Number(b.data.available_balance);
    if (Number.isFinite(avail) && toKobo(avail) < p.amount_kobo) return revert(`Flutterwave balance (${naira(toKobo(avail))}) is below the payout (${naira(p.amount_kobo)})`);
  } catch (e) { /* cannot read the balance: carry on, Flutterwave decides */ }

  // 5. send, with the payout reference as the transfer reference: a repeat is refused by Flutterwave
  await logEvent(db, p, 'EXECUTION_STARTED', system, `sending ${naira(p.amount_kobo)} to ${p.dest_bank_code} ${p.dest_account_number}`);
  let res, json;
  try {
    res = await fetchImpl(`${FLW}/transfers`, { method: 'POST', headers, body: JSON.stringify({
      account_bank: p.dest_bank_code, account_number: p.dest_account_number, amount: p.amount_kobo / 100, currency: 'NGN', debit_currency: 'NGN',
      reference: p.payout_ref, narration: `Zillion collections ${soc.name || p.coop_id} ${p.payout_ref}`.slice(0, 100),
    }) });
    json = await res.json();
  } catch (e) {
    return unknownOutcome(db, p, `no usable reply from Flutterwave (${e.message})`);
  }
  if (res.status >= 500) return unknownOutcome(db, p, `Flutterwave answered with a server error (${res.status})`);
  if (json && json.status === 'success' && json.data) {
    await db.from('coop_flutterwave_payouts').update({ flw_transfer_id: String(json.data.id), flw_status: json.data.status || 'NEW', transfer_fee_kobo: json.data.fee != null ? toKobo(json.data.fee) : null }).eq('id', p.id);
    await logEvent(db, p, 'SENT', system, `accepted by Flutterwave (transfer ${json.data.id}, status ${json.data.status || 'NEW'})`);
    return { sent: true, transfer_id: String(json.data.id) };
  }
  const message = (json && json.message) || 'Flutterwave refused the transfer';
  if (/already exist|duplicate/i.test(message)) return unknownOutcome(db, p, `Flutterwave says this reference already exists: ${message}`);
  return revert(message);
}

/** We cannot tell whether the transfer exists. NEVER retry on our own: freeze it for a person to check with Flutterwave. */
async function unknownOutcome(db, p, why) {
  await db.from('coop_flutterwave_payouts').update({ needs_verification: true, failure_reason: why }).eq('id', p.id);
  await logEvent(db, p, 'OUTCOME_UNKNOWN', SYSTEM_ACTOR, why);
  await logAlert(db, { severity: 'CRITICAL', source: SOURCE, message: `Payout ${p.payout_ref} (${naira(p.amount_kobo)}): ${why}. It will NOT be retried - check Flutterwave, then confirm it was sent or not sent.`, context: { payout_id: p.id, coop_id: p.coop_id } }).catch(() => {});
  return { unknown: true, reason: why };
}

async function failPayout(db, p, reason, from) {
  const done = await claim(db, p.id, from, { status: 'FAILED', failure_reason: reason });
  if (!done) return null;
  await releaseRows(db, p.id);
  await logEvent(db, p, 'FAILED', SYSTEM_ACTOR, reason);
  await logAlert(db, { severity: 'WARNING', source: SOURCE, message: `Payout ${p.payout_ref} (${naira(p.amount_kobo)}) failed: ${reason}. The receipts are free to be paid out again.`, context: { payout_id: p.id, coop_id: p.coop_id } }).catch(() => {});
  return done;
}

// ── confirming ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Books a payout that has really been paid (by Flutterwave or by hand) on BOTH sides. Idempotent: only the first caller wins the claim. */
async function completePayout(db, p, { reference, feeKobo = 0, execution, actor = SYSTEM_ACTOR, now = new Date() }) {
  const paid = await claim(db, p.id, ['PROCESSING', 'APPROVED'], { status: 'PAID', execution: execution || p.execution, paid_at: now.toISOString(), paid_reference: reference || p.payout_ref, transfer_fee_kobo: feeKobo || null, failure_reason: null, needs_verification: false });
  if (!paid) return { duplicate: true };
  const ref = p.payout_ref;
  let societyRowId = null, zillionEntryId = null;
  try {   // the society's books: money Flutterwave/Zillion held for it has now reached its bank
    const { data: ledgerRow, error } = await db.from('coop_flutterwave_ledger').insert({
      coop_id: p.coop_id, direction: 'OUT', entry_type: 'SETTLEMENT', amount_kobo: p.amount_kobo, gross_kobo: p.amount_kobo, fees_kobo: 0, live_mode: true, channel: 'virtual_account',
      purpose: 'zillion_payout', flw_settlement_id: ref, settlement_account_number: p.dest_account_number, account_matches: true, expected_kobo: p.amount_kobo, variance_kobo: 0, match_status: 'MATCHED',
      narration: `Zillion payout ${ref}${execution === 'MANUAL' ? ' (paid manually, ref ' + reference + ')' : ''}`, provider_data: { payout_id: p.id, execution: execution || p.execution }, occurred_at: now.toISOString(),
    }).select('id').single();
    if (!error) {
      societyRowId = ledgerRow.id;
      const settleCode = p.settlement_account_code || BANK_CODE;
      if (await accountingIsReady(db, p.coop_id)) {
        const accounts = await getAccounts(db, p.coop_id, [settleCode, BANK_CODE, FLW_CLEARING_CODE]);
        const bank = accounts[settleCode] || accounts[BANK_CODE], clearing = accounts[FLW_CLEARING_CODE];
        if (bank && clearing) {
          const posted = await postEntryLines(db, p.coop_id, `Zillion payout ${ref} to ${p.dest_account_name || 'settlement account'} ${p.dest_account_number}`, 'ledger:payout', [{ account: bank, type: 'debit', amountKobo: p.amount_kobo }, { account: clearing, type: 'credit', amountKobo: p.amount_kobo }]);
          if (posted.booked) await db.from('coop_flutterwave_ledger').update({ journal_entry_id: posted.entry_id }).eq('id', societyRowId);
        }
      }
    }
    await db.from('coop_flutterwave_ledger').update({ settled_in: ref, settled_at: now.toISOString(), match_status: 'SETTLED' }).eq('payout_id', p.id);
  } catch (e) {
    await logAlert(db, { severity: 'WARNING', source: SOURCE, message: `Payout ${ref} was paid but the society's books could not be fully updated: ${e.message}`, context: { payout_id: p.id } }).catch(() => {});
  }
  try {   // Zillion's own books: the liability to the society goes down as cash goes out
    const accts = await zl.getAccounts(db, [ZILLION_BANK, ZILLION_OWED, ZILLION_FEES]);
    if (accts[ZILLION_BANK] && accts[ZILLION_OWED]) {
      const fee = feeKobo > 0 && accts[ZILLION_FEES] ? feeKobo : 0;
      const lines = [{ account: accts[ZILLION_OWED], type: 'debit', amountKobo: p.amount_kobo }];
      if (fee) lines.push({ account: accts[ZILLION_FEES], type: 'debit', amountKobo: fee });
      lines.push({ account: accts[ZILLION_BANK], type: 'credit', amountKobo: p.amount_kobo + fee });
      const posted = await zl.postEntryLines(db, `Payout ${ref} to society ${p.coop_id}`, 'system:payout', lines);
      if (posted.booked) zillionEntryId = posted.entry_id;
    }
  } catch (e) {
    await logAlert(db, { severity: 'WARNING', source: SOURCE, message: `Payout ${ref} was paid but Zillion's own books could not be updated: ${e.message}`, context: { payout_id: p.id } }).catch(() => {});
  }
  await db.from('coop_flutterwave_payouts').update({ society_ledger_row_id: societyRowId, zillion_journal_entry_id: zillionEntryId }).eq('id', p.id);
  await logEvent(db, p, 'PAID', actor, `${naira(p.amount_kobo)} paid${execution === 'MANUAL' ? ` manually (ref ${reference})` : ''}${feeKobo ? `; transfer fee ${naira(feeKobo)}` : ''}`);
  await logAlert(db, { severity: 'INFO', source: SOURCE, message: `Payout ${ref} of ${naira(p.amount_kobo)} to ${p.coop_id} is complete`, context: { payout_id: p.id } }).catch(() => {});
  return { paid: true, society_ledger_row_id: societyRowId, zillion_journal_entry_id: zillionEntryId };
}

/** Acts on what Flutterwave says about a transfer (from polling or a webhook that was re-verified). */
async function applyTransferResult(db, p, t) {
  const status = String(t.status || '').toUpperCase();
  if (status === 'SUCCESSFUL') return completePayout(db, p, { reference: p.payout_ref, feeKobo: t.fee != null ? toKobo(t.fee) : 0, execution: 'AUTOMATIC' });
  if (status === 'FAILED') return { failed: await failPayout(db, p, t.complete_message || 'Flutterwave reported the transfer as failed', ['PROCESSING']) };
  await db.from('coop_flutterwave_payouts').update({ flw_status: status || p.flw_status }).eq('id', p.id);
  return { pending: true };
}

/** Asks Flutterwave how a PROCESSING payout is getting on (by transfer id, or - if we never got one - by reference). */
async function refreshPayout(db, payoutId, { fetchImpl = fetch, secretKey = process.env.FLW_V3_SECRET_KEY } = {}) {
  const p = await getPayout(db, payoutId);
  if (!p || p.status !== 'PROCESSING') return { skipped: 'not processing' };
  if (!isLiveKey(secretKey)) return { skipped: 'no live Flutterwave key' };
  const headers = { Authorization: `Bearer ${String(secretKey).trim()}` };
  try {
    let id = p.flw_transfer_id;
    if (!id) {
      const l = await (await fetchImpl(`${FLW}/transfers?reference=${encodeURIComponent(p.payout_ref)}`, { headers })).json();
      const hit = rowsOf(l && l.data).find(x => x && x.reference === p.payout_ref);
      if (!hit) { await logEvent(db, p, 'NOT_FOUND_AT_FLUTTERWAVE', SYSTEM_ACTOR, 'no transfer with this reference was found'); return { notFound: true }; }
      id = String(hit.id); await db.from('coop_flutterwave_payouts').update({ flw_transfer_id: id }).eq('id', p.id);
    }
    const j = await (await fetchImpl(`${FLW}/transfers/${encodeURIComponent(id)}`, { headers })).json();
    if (!j || j.status !== 'success' || !j.data) return { error: (j && j.message) || 'Flutterwave did not return the transfer' };
    return applyTransferResult(db, { ...p, flw_transfer_id: id }, j.data);
  } catch (e) { return { error: e.message }; }
}

// ── people stepping in ───────────────────────────────────────────────────────────────────────────────────────────────────
/** The money was sent by hand (or the automatic path is off): record it, with the bank reference. Not the person who prepared it. */
async function markPaidManually(db, actor, payoutId, { reference, feeKobo = 0, now = new Date() } = {}) {
  if (!APPROVER_ROLES.includes(actor.role)) return fail(403, 'Only SUPER_ADMIN or COMPLIANCE can record a manual payment');
  const p = await getPayout(db, payoutId);
  if (!p) return fail(404, 'Payout not found');
  if (p.requested_by === actor.id) return fail(403, 'You prepared this payout, so someone else must confirm it was paid');
  if (!(p.status === 'APPROVED' || (p.status === 'PROCESSING' && p.needs_verification))) return fail(409, `This payout is ${p.status}; only an approved payout (or one awaiting verification) can be marked paid`);
  if (!reference || String(reference).trim().length < 4) return fail(400, 'Enter the bank or Flutterwave reference of the payment');
  const r = await completePayout(db, p, { reference: String(reference).trim(), feeKobo: Number(feeKobo) || 0, execution: 'MANUAL', actor, now });
  return r.duplicate ? fail(409, 'This payout was already completed') : { ok: true, payout: await getPayout(db, p.id), ...r };
}

/** After checking in Flutterwave that NO transfer exists for an unknown-outcome payout: allow it to be sent again. */
async function confirmNotSent(db, actor, payoutId, note) {
  if (!APPROVER_ROLES.includes(actor.role)) return fail(403, 'Only SUPER_ADMIN or COMPLIANCE can do this');
  const p = await getPayout(db, payoutId);
  if (!p || p.status !== 'PROCESSING' || !p.needs_verification) return fail(409, 'This payout is not awaiting verification');
  if (p.requested_by === actor.id) return fail(403, 'Someone other than the person who prepared this payout must confirm that');
  if (!note || String(note).trim().length < 8) return fail(400, 'Describe how you checked that nothing was sent (for example "no transfer with this reference in the Flutterwave dashboard")');
  const done = await claim(db, p.id, ['PROCESSING'], { status: 'APPROVED', needs_verification: false, failure_reason: 'confirmed not sent; ready to retry' });
  await logEvent(db, p, 'CONFIRMED_NOT_SENT', actor, note);
  return { ok: true, payout: done };
}

async function retryPayout(db, actor, payoutId, opts = {}) {
  if (!APPROVER_ROLES.includes(actor.role)) return fail(403, 'Only SUPER_ADMIN or COMPLIANCE can retry a payout');
  const p = await getPayout(db, payoutId);
  if (!p || p.status !== 'APPROVED') return fail(409, 'Only an approved payout can be retried');
  const r = await executePayout(db, p.id, opts);
  return { ok: true, result: r, payout: await getPayout(db, p.id) };
}

// ── the daily job ────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Proposes (never approves) payouts for every society with owed receipts old enough. */
async function autoPrepare(db, { cfg = config(), now = new Date(), fetchImpl = fetch, secretKey = process.env.FLW_V3_SECRET_KEY, maxSocieties = 20 } = {}) {
  const cutoff = new Date(now.getTime() - cfg.minAgeHours * 3600000).toISOString();
  const { data } = await db.from('coop_flutterwave_ledger').select('coop_id, occurred_at').eq('entry_type', 'PAYMENT').eq('live_mode', true).eq('channel', 'virtual_account')
    .is('settled_in', null).is('payout_id', null).lte('occurred_at', cutoff).order('occurred_at').limit(1000);
  const order = []; for (const r of rowsOf(data)) if (!order.includes(r.coop_id)) order.push(r.coop_id);
  const out = { societies: order.length, prepared: 0, skipped: [] };
  for (const coopId of order.slice(0, maxSocieties)) {
    const r = await preparePayout(db, SYSTEM_ACTOR, coopId, { cfg, now, fetchImpl, secretKey, minAgeHours: cfg.minAgeHours });
    if (r.ok) out.prepared++; else out.skipped.push(`${coopId}: ${r.error}`);
  }
  return out;
}

module.exports = {
  config, namesMatch, resolveAccountName, preparePayout, approvePayout, rejectPayout, cancelPayout, executePayout, completePayout, applyTransferResult,
  refreshPayout, markPaidManually, confirmNotSent, retryPayout, autoPrepare, getPayout, eventsOf, APPROVER_ROLES, PREPARER_ROLES, SYSTEM_ACTOR, ACTIVE,
};
