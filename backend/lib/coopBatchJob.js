/**
 * zillion/backend/lib/coopBatchJob.js
 *
 * Machinery for background work that must finish inside a hard time limit. A Netlify scheduled function is
 * killed after 30 seconds and that cannot be raised. The nightly job used to do every pass in one invocation, doing
 * per-row work for every society, plan, investment, loan and member on every run - even when there was nothing to
 * do. Past a certain size it would be killed partway through, and the passes that move money (interest, accruals,
 * maturities) ran LAST, so they would have been the ones silently starved.
 *
 *   TimeBudget        a deadline that can be shared out fairly between passes
 *   runBatchedPass    works through a table in id order, one page at a time, until its budget runs out, saving a
 *                     cursor so the next run resumes exactly where this one stopped - every row is eventually reached
 *   checkPassLag      raises an alert if a pass has not completed a full cycle in too long, so falling behind is
 *                     visible instead of silent
 *
 * Progress is stored in scheduled_job_state. If that table is missing (migration not yet run) everything still
 * works - each run just starts from the beginning, as the old job did - and it says so once in the logs.
 */
'use strict';

class TimeBudget {
  constructor(totalMs, { now = Date.now } = {}) { this.now = now; this.deadline = now() + Math.max(0, totalMs); }
  remainingMs() { return Math.max(0, this.deadline - this.now()); }
  expired() { return this.remainingMs() <= 0; }
  /** A share of what is LEFT, never beyond this budget's own deadline. Unused time flows on to later slices. */
  slice(fraction) {
    const b = new TimeBudget(0, { now: this.now });
    b.deadline = this.now() + Math.floor(this.remainingMs() * fraction);
    return b;
  }
}

function createJobStateStore(db, { now = () => new Date() } = {}) {
  let warned = false;
  const warn = m => { if (!warned) { warned = true; console.warn('[coopBatchJob] job state is not being persisted (is the scheduled_job_state table created?):', m); } };
  return {
    async load(key) {
      try {
        const { data, error } = await db.from('scheduled_job_state').select('*').eq('job_key', key).maybeSingle();
        if (error) { warn(error.message); return { job_key: key }; }
        return data || { job_key: key };
      } catch (e) { warn(e.message); return { job_key: key }; }
    },
    async save(key, patch) {
      try {
        const { error } = await db.from('scheduled_job_state').upsert({ job_key: key, ...patch, updated_at: now().toISOString() }, { onConflict: 'job_key' });
        if (error) warn(error.message);
      } catch (e) { warn(e.message); }
    },
  };
}

/**
 * @param {object} o
 * @param {string} o.key                     stable name of the pass (the row in scheduled_job_state)
 * @param {(cursor:string|null, limit:number) => Promise<Array>} o.fetchPage   next rows AFTER cursor, in cursor order
 * @param {(items:Array) => Promise<any>} [o.prepare]   one bulk read for the whole page, handed to processItem
 * @param {(item:object, ctx:any) => Promise<void>} o.processItem   must be safe to repeat: a row can be seen again
 * @param {(item:object) => string} [o.cursorOf]
 * @returns {Promise<{key, processed, errors, pages, completedCycle, expired}>}
 */
async function runBatchedPass({ key, store, budget, pageSize = 200, fetchPage, prepare, processItem, cursorOf = x => x.id, now = () => new Date(), log = console }) {
  const state = await store.load(key);
  let cursor = state.cursor || null;
  const stats = { key, processed: 0, errors: 0, pages: 0, completedCycle: false, expired: false };
  const startedIso = now().toISOString();
  let cycleMarked = !!state.cycle_started_at;

  try {
    while (true) {
      if (budget.expired()) { stats.expired = true; break; }
      const items = await fetchPage(cursor, pageSize);
      stats.pages++;
      if (!items.length) { stats.completedCycle = true; break; }
      const ctx = prepare ? await prepare(items) : undefined;

      let stoppedEarly = false;
      for (const item of items) {
        if (budget.expired()) { stats.expired = true; stoppedEarly = true; break; }
        // One row failing must never stall the whole pass: log it, move on, and it is seen again next cycle.
        try { await processItem(item, ctx); }
        catch (e) { stats.errors++; log.error(`[coopBatchJob] ${key}: row ${cursorOf(item)} failed: ${e.message}`); }
        cursor = cursorOf(item); stats.processed++;
      }
      await store.save(key, { cursor, ...(cycleMarked ? {} : { cycle_started_at: startedIso }) });   // checkpoint every page
      cycleMarked = true;
      if (stoppedEarly) break;
      if (items.length < pageSize) { stats.completedCycle = true; break; }   // a short page is the end of the table
    }
  } catch (e) {
    stats.errors++;
    log.error(`[coopBatchJob] ${key}: pass stopped: ${e.message}`);
    await store.save(key, { cursor });   // keep whatever progress was made
  }

  const finished = now().toISOString();
  if (stats.completedCycle) await store.save(key, { cursor: null, cycle_started_at: null, last_completed_at: finished, last_run_at: finished, processed_last_run: stats.processed });
  else await store.save(key, { last_run_at: finished, processed_last_run: stats.processed });
  return stats;
}

/**
 * Has this pass gone too long without completing a full cycle? If so, alert - at most once a day per pass.
 * A cycle that keeps taking longer than expected means the work has outgrown the time budget.
 */
async function checkPassLag({ key, store, maxCycleHours, now = () => new Date(), alert }) {
  const st = await store.load(key);
  const reference = st.last_completed_at || st.first_run_at;
  if (!reference) return false;
  const nowMs = now().getTime();
  const hours = (nowMs - new Date(reference).getTime()) / 3600000;
  if (hours <= maxCycleHours) return false;
  if (st.last_lag_alert_at && nowMs - new Date(st.last_lag_alert_at).getTime() < 24 * 3600000) return false;
  await alert({ key, hours: Math.round(hours), maxCycleHours, lastCompletedAt: st.last_completed_at || null });
  await store.save(key, { last_lag_alert_at: now().toISOString() });
  return true;
}

module.exports = { TimeBudget, createJobStateStore, runBatchedPass, checkPassLag };
