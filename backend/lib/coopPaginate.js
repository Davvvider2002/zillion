/**
 * zillion/backend/lib/coopPaginate.js
 *
 * PostgREST (Supabase) returns at most 1,000 rows per request by default,
 * and returns them SILENTLY truncated - no error, no warning. Any report
 * that sums "all rows" with a single query is therefore correct only until
 * a society outgrows 1,000 rows, then quietly wrong. Anything that has to
 * be complete (ledger totals, sub-ledgers) must page through instead.
 *
 * buildQuery must return a FRESH query each call (a builder is consumed by
 * range()), and should include a stable .order() so pages never overlap or
 * skip rows.
 */
'use strict';

async function fetchAllRows(buildQuery, pageSize = 1000) {
  const all = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const page = data || [];
    all.push(...page);
    if (page.length < pageSize) break;
  }
  return all;
}

/** Splits ids into batches so an .in() filter never builds an oversized URL. */
function chunk(items, size = 100) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

module.exports = { fetchAllRows, chunk };
