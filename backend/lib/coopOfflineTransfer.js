/**
 * zillion/backend/lib/coopOfflineTransfer.js
 *
 * Proof of funds for an OFFLINE loan repayment. The member sends Zil to their society's merchant account through the
 * normal wallet, then tells the platform "apply that to my loan". The coin ledger proves the money moved; what has to be
 * decided is which ledger transfers this claim is spending.
 *
 * The check used to compare a claim with the TOTAL recently transferred, never with what was still unclaimed. So one
 * NGN 1,000 transfer could back a 300 claim, then a 700 claim, then the same 1,000 against a second loan: the society
 * would record NGN 3,000 of collections for NGN 1,000 received, and a loan would close early. Its only guard was "same
 * loan, same amount, within the window", which missed every claim of a different amount or loan - and wrongly rejected
 * a member who really did send two identical instalments.
 *
 * Now each claim consumes SPECIFIC ledger transfers, whole, exactly once:
 *   - only genuine member -> society-merchant TRANSFER events count
 *   - a transfer the society has since sent BACK to the member does not count
 *   - a transfer already applied (a row in coop_offline_transfer_claims) does not count
 *   - the claim amount must equal the exact total of some unclaimed transfers, which are then reserved
 * UNIQUE(ledger_entry_id) on the claims table makes "exactly once" a property of the database, so two requests racing
 * for the same transfer cannot both win.
 */
'use strict';

const crypto = require('crypto');
const { fetchAllRows, chunk } = require('./coopPaginate');
const { uniqueReference } = require('./coopReference');

const OFFLINE_WINDOW_MINUTES = 15;

const MAX_SUBSET_ROWS = 18;   // 2^18 combinations at worst; a member has a handful of transfers inside a 15-minute window
const naira = k => '₦' + (k / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Picks whole transfers that add up to EXACTLY amountKobo. A single transfer of that size wins (the common case);
 * otherwise the fewest transfers, and among equals the oldest. Returns null if no combination matches.
 */
function findExactTransferSubset(transfers, amountKobo) {
  if (!Number.isInteger(amountKobo) || amountKobo <= 0) return null;
  const list = [...transfers].map(t => ({ ...t, amount: Number(t.amount) })).filter(t => t.amount > 0)
    .sort((a, b) => Number(a.entry_id) - Number(b.entry_id));
  const single = list.find(t => t.amount === amountKobo);
  if (single) return [single];

  const usable = list.filter(t => t.amount < amountKobo).slice(0, MAX_SUBSET_ROWS);
  const n = usable.length;
  if (n < 2) return null;
  const sums = new Float64Array(1 << n);
  let bestMask = 0, bestCount = Infinity;
  for (let mask = 1; mask < (1 << n); mask++) {
    const low = mask & -mask;
    sums[mask] = sums[mask ^ low] + usable[31 - Math.clz32(low)].amount;
    if (sums[mask] !== amountKobo) continue;
    let c = 0; for (let m = mask; m; m &= m - 1) c++;
    if (c < bestCount || (c === bestCount && mask < bestMask)) { bestCount = c; bestMask = mask; }
  }
  return bestMask ? usable.filter((_, i) => bestMask & (1 << i)) : null;
}

/** The member's transfers to the society inside the window that can still be claimed. */
async function getUnclaimedTransfers(db, { memberHash, merchantHash, windowStart }) {
  const transfers = (await fetchAllRows(() => db.from('coin_ledger').select('entry_id, coin_id, amount, changed_at')
    .eq('event_type', 'TRANSFER').eq('prev_holder_hash', memberHash).eq('new_holder_hash', merchantHash)
    .gte('changed_at', windowStart).order('entry_id'))).map(t => ({ ...t, amount: Number(t.amount) }));
  if (!transfers.length) return { unclaimed: [], claimedCount: 0, refundedCount: 0 };

  const claimed = new Set();
  for (const part of chunk(transfers.map(t => t.entry_id))) {
    for (const r of await fetchAllRows(() => db.from('coop_offline_transfer_claims').select('ledger_entry_id').in('ledger_entry_id', part).order('ledger_entry_id'))) claimed.add(Number(r.ledger_entry_id));
  }
  // A transfer the society has since sent back to the member is no longer money the society holds. entry_id is the ledger's
  // own sequence, so "later" means a higher entry_id.
  const refunds = [];
  for (const part of chunk([...new Set(transfers.map(t => t.coin_id))])) {
    refunds.push(...await fetchAllRows(() => db.from('coin_ledger').select('entry_id, coin_id')
      .eq('event_type', 'TRANSFER').eq('prev_holder_hash', merchantHash).eq('new_holder_hash', memberHash)
      .in('coin_id', part).gte('changed_at', windowStart).order('entry_id')));
  }
  const isRefunded = t => refunds.some(r => r.coin_id === t.coin_id && Number(r.entry_id) > Number(t.entry_id));

  const isClaimed = t => claimed.has(Number(t.entry_id));
  return { unclaimed: transfers.filter(t => !isClaimed(t) && !isRefunded(t)), claimedCount: transfers.filter(isClaimed).length, refundedCount: transfers.filter(t => !isClaimed(t) && isRefunded(t)).length };
}

/**
 * Reserves the chosen transfers in one statement (all or nothing). A duplicate key means someone else got there first.
 * `rows` come from planApplication, so each claim records how much of THAT transfer went to the loan and how much was excess.
 */
async function reserveTransferClaims(db, rows, { coopId, memberId, loanId, excessDisposition = null }) {
  const { data, error } = await db.from('coop_offline_transfer_claims').insert(rows.map(t => ({
    ledger_entry_id: t.entry_id, coop_id: coopId, member_id: memberId, loan_id: loanId, claimed_kobo: t.amount,
    applied_kobo: t.applied_kobo === undefined ? t.amount : t.applied_kobo, excess_kobo: t.excess_kobo || 0,
    excess_disposition: (t.excess_kobo || 0) > 0 ? excessDisposition : null,
  }))).select('id');
  if (error) return { ok: false, reason: error.code === '23505' ? 'already_claimed' : 'error', error: error.message };
  return { ok: true, ids: (data || []).map(r => r.id) };
}
async function releaseTransferClaims(db, ids) {
  const { error } = await db.from('coop_offline_transfer_claims').delete().in('id', ids);
  return { ok: !error, error: error && error.message };
}
async function linkTransferClaims(db, ids, repaymentId) {
  try { await db.from('coop_offline_transfer_claims').update({ repayment_id: repaymentId }).in('id', ids); } catch (_) { /* informational only */ }
}

/** A message that tells the member what WOULD work, instead of just "not found". */
function describeShortfall({ unclaimed, claimedCount, refundedCount }, amountKobo, windowMinutes) {
  const extra = [claimedCount ? `${claimedCount} recent transfer(s) have already been applied` : null, refundedCount ? `${refundedCount} was returned to you` : null].filter(Boolean).join('; ');
  if (!unclaimed.length) return `Could not find an unclaimed transfer from you to your society in the last ${windowMinutes} minutes.${extra ? ' (' + extra + '.)' : ''} Send the Zil first, then apply it here.`;
  return `You asked to apply ${naira(amountKobo)}, but your unclaimed transfers to your society in the last ${windowMinutes} minutes are: ${unclaimed.map(t => naira(t.amount)).join(', ')}. The amount must match the transfer(s) you sent exactly.`;
}




/** The two holder hashes an offline repayment is proven against, or null if the society has no merchant account. */
async function getOfflineHolders(db, member) {
  const { data: society } = await db.from('coop_societies').select('merchant_id').eq('coop_id', member.coop_id).maybeSingle();
  if (!society || !society.merchant_id || !member.phone_normalized) return null;
  return { memberHash: crypto.createHash('sha256').update(member.phone_normalized).digest('hex'), merchantHash: `MERCHANT-${society.merchant_id}` };
}

/**
 * Which transfers a request means. A client no longer has to know an exact amount:
 *   entryIds  -> exactly those transfers (each must still be unclaimed)
 *   amountKobo -> the transfers that add up to exactly that amount (the original interface)
 *   neither    -> everything the member has sent and not yet applied ("apply what I just sent")
 */
function pickTransfers(unclaimed, { amountKobo, entryIds } = {}) {
  const has = v => v !== undefined && v !== null;
  const oldestFirst = list => [...list].sort((a, b) => Number(a.entry_id) - Number(b.entry_id));
  if (Array.isArray(entryIds) && entryIds.length) {
    const wanted = [...new Set(entryIds.map(Number))];
    if (wanted.some(n => !Number.isInteger(n) || n <= 0)) return { error: 'invalid_ids' };
    const byId = new Map(unclaimed.map(t => [Number(t.entry_id), t]));
    if (wanted.some(id => !byId.has(id))) return { error: 'unavailable_ids' };
    const selection = oldestFirst(wanted.map(id => byId.get(id)));
    if (has(amountKobo) && selection.reduce((s, t) => s + t.amount, 0) !== amountKobo) return { error: 'no_match' };
    return { selection, mode: 'ids' };
  }
  if (has(amountKobo)) {
    const selection = findExactTransferSubset(unclaimed, amountKobo);
    return selection ? { selection, mode: 'amount' } : { error: 'no_match' };
  }
  return unclaimed.length ? { selection: oldestFirst(unclaimed), mode: 'all' } : { error: 'none' };
}

/**
 * Splits what the member sent between the loan and any excess. The loan is credited AT MOST what it still owes - it used to
 * record the whole transfer, so an over-payment left the loan over-credited and the books distorted. Whole transfers are
 * consumed (a coin cannot be half spent), oldest first, so any excess falls on the newest transfer(s).
 */
function planApplication(selection, remainingKobo) {
  let left = Math.max(0, Math.floor(remainingKobo));
  const rows = selection.map(t => { const applied = Math.min(t.amount, left); left -= applied; return { ...t, applied_kobo: applied, excess_kobo: t.amount - applied }; });
  const totalKobo = rows.reduce((s, r) => s + r.amount, 0), applyKobo = rows.reduce((s, r) => s + r.applied_kobo, 0);
  return { rows, totalKobo, applyKobo, excessKobo: totalKobo - applyKobo };
}

/** The plan an excess is credited to: the member's earliest ACTIVE plan. savings_plan_id is NOT NULL on the savings ledger, so no plan means nowhere to credit it. */
async function findExcessPlan(db, memberId) {
  const { data } = await db.from('coop_savings_plans').select('id, created_at').eq('member_id', memberId).eq('status', 'ACTIVE').order('created_at').limit(1);
  return data && data[0] ? data[0] : null;
}

/** Credits the excess to a savings plan. The GL entry is posted by the caller (it needs the member's name). */
async function creditExcessToSavings(db, { coopId, memberId, planId, excessKobo }) {
  const reference = uniqueReference('Excess from offline loan repayment');
  const { error } = await db.from('coop_savings_transactions').insert({
    coop_id: coopId, member_id: memberId, savings_plan_id: planId, amount_kobo: excessKobo,
    source: 'offline_zil_excess', reference, recorded_by: 'member:offline_zil' });
  return { ok: !error, error: error && error.message, reference };
}

/**
 * Claims made recently by this member for this loan, grouped per repayment. Lets a RETRY of a claim that already went through
 * (a lost response, a double tap) be recognised even after its transfers are spent and its repayment was capped.
 */
async function recentClaimGroups(db, { memberId, loanId, windowStart }) {
  const rows = await fetchAllRows(() => db.from('coop_offline_transfer_claims').select('id, repayment_id, claimed_kobo, applied_kobo')
    .eq('member_id', memberId).eq('loan_id', loanId).gte('created_at', windowStart).order('id'));
  const groups = new Map();
  for (const r of rows) {
    const k = r.repayment_id || r.id, g = groups.get(k) || { totalKobo: 0, appliedKobo: 0 };
    g.totalKobo += Number(r.claimed_kobo); g.appliedKobo += Number(r.applied_kobo ?? r.claimed_kobo); groups.set(k, g);
  }
  return [...groups.values()];
}

/** What a client needs to recover from a mismatch without another round trip. */
const describeAvailable = unclaimed => ({
  available_transfers: unclaimed.map(t => ({ entry_id: Number(t.entry_id), amount_kobo: t.amount, sent_at: t.changed_at })),
  suggested_amount_kobo: unclaimed.reduce((s, t) => s + t.amount, 0),
});

module.exports = { findCreditPlan: findExcessPlan, findExactTransferSubset, getUnclaimedTransfers, reserveTransferClaims, releaseTransferClaims, linkTransferClaims, describeShortfall,
  getOfflineHolders, pickTransfers, planApplication, findExcessPlan, creditExcessToSavings, recentClaimGroups, describeAvailable, MAX_SUBSET_ROWS, OFFLINE_WINDOW_MINUTES };
