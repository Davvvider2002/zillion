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

const { fetchAllRows, chunk } = require('./coopPaginate');

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

/** Reserves the chosen transfers in one statement (all or nothing). A duplicate key means someone else got there first. */
async function reserveTransferClaims(db, transfers, { coopId, memberId, loanId }) {
  const { data, error } = await db.from('coop_offline_transfer_claims')
    .insert(transfers.map(t => ({ ledger_entry_id: t.entry_id, coop_id: coopId, member_id: memberId, loan_id: loanId, claimed_kobo: t.amount }))).select('id');
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

module.exports = { findExactTransferSubset, getUnclaimedTransfers, reserveTransferClaims, releaseTransferClaims, linkTransferClaims, describeShortfall, MAX_SUBSET_ROWS };
