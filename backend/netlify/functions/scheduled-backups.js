/**
 * zillion/backend/netlify/functions/scheduled-backups.js
 *
 * Runs automatically once a day (see netlify.toml). Takes a fresh backup of every active society, and one
 * platform backup, whenever the last successful one is more than 20 hours old (see coopBackup.DUE_AFTER_HOURS) -
 * so a run that is late or interrupted just catches up next time rather than skipping a day.
 *
 * TIME LIMIT: same 30-second ceiling as scheduled-reconcile.js. Backing up every society in one invocation
 * would not fit once there are more than a handful, so this works through the due list in a stable order
 * (coop_id) within a time budget and saves a cursor in scheduled_job_state - a run that runs out of time
 * resumes exactly where it stopped, and because "due" is checked fresh each time, a society that already got
 * its backup earlier in the same day is simply skipped when the cursor wraps back around to it.
 *
 * Every scheduled backup is sealed with the platform's own key (BACKUP_ENCRYPTION_KEY), never a passphrase -
 * nobody types a passphrase in the middle of the night. If that key is not configured, backups are skipped and
 * a single alert is raised (at most once a day) rather than silently writing unencrypted backups.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { logAlert } = require('../../lib/alerts');
const { fetchAllRows } = require('../../lib/coopPaginate');
const { TimeBudget, createJobStateStore } = require('../../lib/coopBatchJob');
const backup = require('../../lib/coopBackup');
const { serverKey } = require('../../lib/coopBackupCrypto');

const BUDGET_MS = parseInt(process.env.BACKUP_BUDGET_MS || '24000');
const JOB_KEY = 'scheduled_backups_cursor';

exports.handler = async () => {
  const startedAt = Date.now();
  const db = getServiceClient();
  const SOURCE = 'scheduled-backups';
  const now = new Date();
  let alertsRaised = 0;
  const raise = async (a) => { alertsRaised++; await logAlert(db, { source: SOURCE, ...a }); };

  if (!serverKey(process.env)) {
    await backup.alertOncePerDay(db, 'backup_no_server_key', now, () => raise({
      severity: 'WARNING', message: 'BACKUP_ENCRYPTION_KEY is not configured — scheduled backups are not running.',
      context: { fix: 'Set BACKUP_ENCRYPTION_KEY to a 32-byte base64 key (openssl rand -base64 32).' },
    }));
    return { statusCode: 200, body: JSON.stringify({ skipped: 'no server key' }) };
  }

  const budget = new TimeBudget(BUDGET_MS);
  const store = createJobStateStore(db, { now: () => now });
  let created = 0, failed = 0, checked = 0;

  // ── platform backup ──────────────────────────────────────────────────────
  try {
    if (await backup.platformBackupDue(db, now)) {
      await backup.createBackup(db, { scope: 'platform', kind: 'scheduled', createdBy: 'scheduled-backups', now: () => now });
      created++;
    }
  } catch (e) {
    failed++; console.error('[scheduled-backups] platform backup failed:', e.message);
    await backup.alertOncePerDay(db, 'backup_platform_failed', now, () => raise({ severity: 'CRITICAL', message: `Scheduled platform backup failed: ${e.message}` }));
  }

  // ── society backups, resumable ───────────────────────────────────────────
  const active = (await fetchAllRows(() => db.from('coop_societies').select('coop_id').neq('status', 'SUSPENDED').order('coop_id'))).map(r => r.coop_id);
  const due = [...await backup.societiesDue(db, active, now)].sort();

  if (due.length) {
    const state = await store.load(JOB_KEY);
    let startIdx = 0;
    if (state.cursor) { const i = due.indexOf(state.cursor); startIdx = i >= 0 ? (i + 1) % due.length : 0; }

    for (let n = 0; n < due.length && !budget.expired(); n++) {
      const coopId = due[(startIdx + n) % due.length];
      checked++;
      try {
        await backup.createBackup(db, { scope: 'society', coopId, kind: 'scheduled', createdBy: 'scheduled-backups', now: () => now });
        created++;
      } catch (e) {
        failed++; console.error(`[scheduled-backups] ${coopId} failed:`, e.message);
      }
      await store.save(JOB_KEY, { cursor: coopId });
    }
  }

  if (failed > 2) {
    await backup.alertOncePerDay(db, 'backup_failures', now, () => raise({ severity: 'WARNING', message: `${failed} scheduled society backup(s) failed today.`, context: { checked, created } }));
  }

  // ── retention (cheap, bulk deletes) ──────────────────────────────────────
  try { await backup.applyRetention(db, { now }); } catch (e) { console.error('[scheduled-backups] retention failed:', e.message); }

  console.log(`[scheduled-backups] due=${due.length} checked=${checked} created=${created} failed=${failed} alerts=${alertsRaised} in ${Date.now() - startedAt}ms`);
  return { statusCode: 200, body: JSON.stringify({ due: due.length, checked, created, failed, alertsRaised }) };
};
