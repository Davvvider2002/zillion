/**
 * zillion/backend/lib/coopCoinDrift.js
 *
 * Pass 1 of the nightly job: compares the immutable coin ledger's implied balance for every holder with what the
 * live coins table says they hold, and reports any drift.
 *
 * It read the ledger view (coin_ledger_holder_balance) with a single unpaged query. PostgREST silently caps that at
 * 1,000 rows, so past 1,000 holders this DETECTOR would have quietly stopped checking everyone beyond the first
 * thousand - and drift there would never have been reported. Now paged. (holder_hash is the view's natural key.)
 */
'use strict';

const { fetchAllRows } = require('./coopPaginate');

const TOLERANCE_KOBO = 100;         // ignore < NGN 1 rounding
const CRITICAL_KOBO = 500000;       // more than NGN 5,000 of drift is critical

/**
 * @param {(alert:{severity,message,context}) => Promise<void>} opts.onDrift
 * @returns {Promise<{checked: boolean, drifts: number}>}  checked=false if the view does not exist yet (silently skipped)
 */
async function checkCoinDrift(db, { onDrift } = {}) {
  let ledgerBalances;
  try {
    ledgerBalances = await fetchAllRows(() => db.from('coin_ledger_holder_balance').select('holder_hash, implied_held_kobo').order('holder_hash'));
  } catch (e) {
    // The view not existing (migration not run) is a one-time setup step tracked separately, not something to alert on every run.
    return { checked: false, drifts: 0 };
  }

  const liveHeld = await fetchAllRows(() => db.from('coins').select('holder_hash, amount').eq('status', 'HELD').order('coin_id'));
  const liveByHolder = {};
  for (const c of liveHeld) {
    if (c.holder_hash == null) continue;   // only skip genuinely missing values ('' is a valid, if degenerate, holder key)
    liveByHolder[c.holder_hash] = (liveByHolder[c.holder_hash] || 0) + (c.amount || 0);
  }

  let drifts = 0;
  for (const row of ledgerBalances) {
    const live = liveByHolder[row.holder_hash] || 0;
    const diff = live - (row.implied_held_kobo || 0);
    if (Math.abs(diff) > TOLERANCE_KOBO) {
      drifts++;
      if (onDrift) await onDrift({
        severity: Math.abs(diff) > CRITICAL_KOBO ? 'CRITICAL' : 'WARNING',
        message: `Coin ledger drift detected for holder ${row.holder_hash.slice(0, 16)}…`,
        context: { holder_hash: row.holder_hash, live_held_kobo: live, ledger_implied_kobo: row.implied_held_kobo, difference_kobo: diff },
      });
    }
  }
  return { checked: true, drifts };
}

module.exports = { checkCoinDrift, TOLERANCE_KOBO, CRITICAL_KOBO };
