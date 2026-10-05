/**
 * zillion/backend/lib/coopTotals.js
 *
 * Per-key totals (savings per plan, dues per member, shares per member) worked out BY THE DATABASE.
 *
 * Why: the society dashboard used to download every transaction a society had ever recorded - 1,000 rows at a time,
 * with offset paging that gets slower on every page - only to add them up in JavaScript. For a 5,000-member society
 * with 150,000 savings transactions that cost 5.7 SECONDS of database time before the network (150 round trips),
 * past Netlify's 10s function limit. The same totals as a GROUP BY take 44ms. See db/migrations/2026-10-05_scale_aggregates.sql.
 *
 * The SQL functions return ONE jsonb map ({ key: total }), so the API's 1,000-row cap cannot truncate it.
 *
 * sumMapViaRpc returns null - not an empty map, not zero - when the function is not installed in this database (or this
 * client has no rpc), so a caller can fall back to the paged read it used before. Any OTHER failure throws: a database
 * error must never quietly turn into "everyone's balance is zero".
 */
'use strict';

function isMissingFunction(error) {
  const code = String(error && error.code || '');
  const msg = String(error && error.message || '');
  return code === 'PGRST202' || code === '42883' || /could not find the function|function .* does not exist/i.test(msg);
}

/** @returns {Promise<Map<string, number>|null>} */
async function sumMapViaRpc(db, fn, coopId) {
  if (!db || typeof db.rpc !== 'function') return null;
  const { data, error } = await db.rpc(fn, { p_coop_id: coopId });
  if (error) {
    if (isMissingFunction(error)) return null;
    throw new Error(`${fn} failed: ${error.message}`);
  }
  const map = new Map();
  for (const [key, total] of Object.entries(data || {})) map.set(key, Number(total) || 0);
  return map;
}

module.exports = { sumMapViaRpc, isMissingFunction };
