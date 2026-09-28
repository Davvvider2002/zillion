/**
 * zillion/backend/lib/coopBackup.js
 *
 * Backup and restore for a society (Coop Admin) and for the whole platform (Zillion Admin).
 *
 * WHERE THE WORK HAPPENS: export and restore run INSIDE the database (backup_export_society / backup_restore_society /
 * backup_export_platform - see db/migrations). What is in a society backup is decided by ONE registry table there, with a
 * guard that reports any coop table nobody classified; numbers round-trip byte-exact because the JSON is never parsed by
 * JavaScript on the way through; and a restore is a single transaction that verifies itself and rolls back on any mismatch.
 * This file adds: the encrypted file, storage, retention, verify-after-write, the undo snapshot, and the safety rules.
 *
 * SAFETY RULES (each one is tested):
 *   - a stored backup is downloaded back and opened straight after it is written; if it cannot be read it is marked FAILED
 *   - a restore always takes a 'pre_restore' snapshot first, and ABORTS if the snapshot cannot be taken - so it is undoable
 *   - a restore needs the society name typed as confirmation, and is previewed (dry-run) before it is applied
 *   - a backup file can never be restored into a different society
 *   - the platform is NEVER restored through the API - only loaded into an empty database with scripts/backup_tool.js
 *   - downloads are always passphrase-encrypted, never plaintext
 */
'use strict';

const C = require('./coopBackupCrypto');
const { fetchAllRows, chunk } = require('./coopPaginate');
const { createJobStateStore } = require('./coopBatchJob');

const BUCKET = 'backups';
const DUE_AFTER_HOURS = 20;                                   // a scheduled backup is due if none succeeded in the last 20h
const KEEP = { scheduled_daily: 14, scheduled_monthly: 12, pre_restore: 10, manual: 30 };
const MAX_INLINE_BYTES = 3 * 1024 * 1024;                     // Netlify responses are capped at 6MB; base64 adds a third

const ymd = d => d.toISOString().slice(0, 10);
const objectPath = (run, now) => `${run.scope === 'society' ? 'society/' + run.coop_id : 'platform'}/${ymd(now)}/${run.id}.zbk`;
const fileNameFor = run => `zillion-${run.scope === 'society' ? run.coop_id : 'platform'}-${String(run.created_at).slice(0, 10)}-${String(run.id).slice(0, 8)}.zbk`;
const rowsOf = counts => Object.values(counts || {}).reduce((s, n) => s + (Number(n) || 0), 0);

async function downloadObject(db, path) {
  const { data, error } = await db.storage.from(BUCKET).download(path);
  if (error || !data) throw new Error(`Could not read the stored backup: ${error ? error.message : 'not found'}`);
  return Buffer.from(await data.arrayBuffer());
}

/**
 * Takes a backup, stores it, and PROVES it can be read back.
 * @param {object} o  { scope:'society'|'platform', coopId?, kind, createdBy, passphrase?, useServerKey? }
 */
async function createBackup(db, { scope, coopId = null, kind = 'manual', createdBy = null, passphrase = null, useServerKey = true, now = () => new Date(), env = process.env }) {
  if (scope === 'society' && !coopId) throw new C.BackupError('BAD_REQUEST', 'coop_id is required for a society backup.');
  if (passphrase) C.seal('x', { passphrase });                 // fail fast on a weak passphrase, before any work is done
  const started = now();
  const { data: run, error: runErr } = await db.from('backup_runs').insert({ scope, coop_id: coopId, kind, status: 'running', created_by: createdBy }).select().single();
  if (runErr || !run) throw new Error(`Could not start the backup: ${runErr ? runErr.message : 'no row'}`);
  const fail = async (e) => { await db.from('backup_runs').update({ status: 'failed', error: String(e.message || e).slice(0, 500) }).eq('id', run.id); };
  let path = null;
  try {
    const rpc = scope === 'society' ? await db.rpc('backup_export_society', { p_coop_id: coopId }) : await db.rpc('backup_export_platform');
    if (rpc.error) throw new Error(rpc.error.message);
    const text = rpc.data;
    if (typeof text !== 'string' || !text.length) throw new Error('The export returned nothing.');
    const key = passphrase ? null : (useServerKey ? C.serverKey(env) : null);
    const sealed = C.seal(text, { passphrase, key });

    path = objectPath(run, started);
    const up = await db.storage.from(BUCKET).upload(path, sealed.buffer, { contentType: 'application/octet-stream', upsert: false });
    if (up.error) throw new Error(`Could not store the backup: ${up.error.message}`);

    // verify-after-write: read it back exactly as a restore would, and compare
    const back = C.open(await downloadObject(db, path), { passphrase, key });
    if (back.sha256 !== sealed.sha256) throw new Error('Verification failed: the stored backup does not match what was exported.');

    const counts = JSON.parse(text).counts || {};
    const patch = { status: 'ok', storage_path: path, bytes: sealed.buffer.length, sha256: sealed.sha256, key_kind: sealed.key_kind, table_counts: counts };
    await db.from('backup_runs').update(patch).eq('id', run.id);
    return { run: { ...run, ...patch, created_at: run.created_at || started.toISOString() }, buffer: sealed.buffer, unencrypted: sealed.key_kind === 'none', rows: rowsOf(counts) };
  } catch (e) {
    if (path) { try { await db.storage.from(BUCKET).remove([path]); } catch (_) { /* nothing more to do */ } }
    await fail(e);
    throw e;
  }
}

/** A stored backup as a file the caller can keep: ALWAYS passphrase-encrypted, never plaintext and never under the platform key. */
async function prepareDownload(db, run, { passphrase, env = process.env } = {}) {
  if (!run || run.status !== 'ok' || !run.storage_path) throw new C.BackupError('NOT_AVAILABLE', 'That backup is not available.');
  const stored = await downloadObject(db, run.storage_path);
  let buffer = stored;
  if (C.inspect(stored).key_kind !== 'passphrase') {
    const { text } = C.open(stored, { key: C.serverKey(env) });   // decrypt with the platform key ...
    buffer = C.seal(text, { passphrase }).buffer;                  // ... and hand it over sealed with THEIR passphrase
  }
  if (buffer.length > MAX_INLINE_BYTES) {
    const { data, error } = await db.storage.from(BUCKET).createSignedUrl(run.storage_path, 120, { download: fileNameFor(run) });
    if (!error && data && C.inspect(stored).key_kind === 'passphrase') return { filename: fileNameFor(run), signed_url: data.signedUrl, bytes: buffer.length };
    throw new C.BackupError('TOO_LARGE', 'This backup is too large to download here. Use scripts/backup_tool.js.');
  }
  return { filename: fileNameFor(run), buffer, bytes: buffer.length };
}

function sourceBuffer(db, run, file) { return file ? Promise.resolve(file) : downloadObject(db, run.storage_path); }

/**
 * Preview (dry-run) or apply a restore of ONE society. Applying always takes an undo snapshot first.
 * @param {object} o  { coopId, societyName, run?, file?, passphrase?, apply, confirm?, acceptSchemaDrift?, actor, env }
 */
async function restoreSociety(db, { coopId, societyName, run = null, file = null, passphrase = null, apply = false, confirm = null, acceptSchemaDrift = false, actor = null, now = () => new Date(), env = process.env }) {
  if (!run && !file) throw new C.BackupError('BAD_REQUEST', 'Choose a stored backup or upload a backup file.');
  if (run && (run.scope !== 'society' || run.coop_id !== coopId || run.status !== 'ok')) throw new C.BackupError('WRONG_SOCIETY', 'That backup does not belong to this society.');
  if (apply && confirm !== `RESTORE ${societyName}`) throw new C.BackupError('CONFIRM_REQUIRED', `To confirm, type exactly: RESTORE ${societyName}`);

  const buffer = await sourceBuffer(db, run, file);
  const { text } = C.open(buffer, { passphrase, key: C.inspect(buffer).key_kind === 'server' ? C.serverKey(env) : null });

  const dry = await db.rpc('backup_restore_society', { p_coop_id: coopId, p_payload: text, p_apply: false });
  if (dry.error) throw new C.BackupError(/belongs to society|different society|not a Zillion|not a society/.test(dry.error.message) ? 'WRONG_SOCIETY' : 'RESTORE_REFUSED', dry.error.message);
  const plan = dry.data;
  if (!apply) return { applied: false, plan };
  if (plan.schema_drift && plan.schema_drift.length && !acceptSchemaDrift) throw Object.assign(new C.BackupError('SCHEMA_DRIFT', 'The database has changed since this backup: some columns it holds no longer exist, and that data would not be restored. Review the preview and confirm to continue anyway.'), { plan });

  let snapshot;
  try { snapshot = await createBackup(db, { scope: 'society', coopId, kind: 'pre_restore', createdBy: actor, now, env }); }
  catch (e) { throw new C.BackupError('SNAPSHOT_FAILED', `Nothing was changed: the safety copy taken before restoring could not be made (${e.message}).`); }

  const done = await db.rpc('backup_restore_society', { p_coop_id: coopId, p_payload: text, p_apply: true });
  if (done.error) throw Object.assign(new C.BackupError('RESTORE_FAILED', `The restore was rolled back and nothing has changed: ${done.error.message}`), { undo_backup_id: snapshot.run.id });
  return { applied: true, plan: done.data, undo_backup_id: snapshot.run.id };
}

async function listBackups(db, { scope = null, coopId = null, limit = 60 } = {}) {
  let q = db.from('backup_runs').select('id, scope, coop_id, kind, status, created_at, bytes, key_kind, table_counts, created_by, error').order('created_at', { ascending: false }).limit(limit);
  if (scope) q = q.eq('scope', scope);
  if (coopId) q = q.eq('coop_id', coopId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data || []).map(r => ({ ...r, rows: rowsOf(r.table_counts), table_counts: undefined }));
}

/** Which of these societies have NO successful scheduled backup in the last 20h - one bulk read, not one query each. */
async function societiesDue(db, coopIds, now) {
  const since = new Date(now.getTime() - DUE_AFTER_HOURS * 3600000).toISOString();
  const have = new Set();
  for (const part of chunk([...new Set(coopIds)])) {
    for (const r of await fetchAllRows(() => db.from('backup_runs').select('coop_id').eq('scope', 'society').eq('kind', 'scheduled').eq('status', 'ok').gte('created_at', since).in('coop_id', part).order('id'))) have.add(r.coop_id);
  }
  return new Set(coopIds.filter(id => !have.has(id)));
}
async function platformBackupDue(db, now) {
  const since = new Date(now.getTime() - DUE_AFTER_HOURS * 3600000).toISOString();
  const { data } = await db.from('backup_runs').select('id').eq('scope', 'platform').eq('kind', 'scheduled').eq('status', 'ok').gte('created_at', since).limit(1);
  return !(data && data.length);
}

/**
 * Retention: per society (and the platform) keep the newest 14 daily backups plus the first of each month for 12 months; keep
 * the last 10 undo snapshots and the last 30 manual downloads. Everything else is deleted from storage and marked 'deleted'.
 */
async function applyRetention(db, { now = new Date(), maxDeletes = 100 } = {}) {
  const runs = await fetchAllRows(() => db.from('backup_runs').select('id, scope, coop_id, kind, created_at, storage_path').eq('status', 'ok').order('created_at', { ascending: false }).order('id'));
  const groups = new Map();
  for (const r of runs) { const k = `${r.scope}|${r.coop_id || ''}|${r.kind}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const doomed = [];
  for (const [, list] of groups) {
    const kind = list[0].kind;
    if (kind === 'scheduled') {
      const keepIds = new Set(list.slice(0, KEEP.scheduled_daily).map(r => r.id));
      const months = new Set();
      for (const r of [...list].reverse()) { const m = String(r.created_at).slice(0, 7); if (!months.has(m) && months.size < KEEP.scheduled_monthly) { months.add(m); keepIds.add(r.id); } }
      // the monthly keeper should be the OLDEST of each month within the last 12 months
      for (const r of list) if (!keepIds.has(r.id)) doomed.push(r);
    } else {
      const n = kind === 'pre_restore' ? KEEP.pre_restore : KEEP.manual;
      doomed.push(...list.slice(n));
    }
  }
  const batch = doomed.slice(0, maxDeletes); let removed = 0;
  for (const part of chunk(batch, 50)) {
    const paths = part.map(r => r.storage_path).filter(Boolean);
    if (paths.length) { const { error } = await db.storage.from(BUCKET).remove(paths); if (error) continue; }
    await db.from('backup_runs').update({ status: 'deleted' }).in('id', part.map(r => r.id));
    removed += part.length;
  }
  return { considered: runs.length, removed, remaining_to_remove: doomed.length - batch.length };
}

/** Is the backup system itself healthy? Used by the admin panel and the nightly job. */
async function healthReport(db, { now = new Date(), env = process.env } = {}) {
  const gaps = await db.rpc('backup_registry_gaps'), order = await db.rpc('backup_registry_order_violations');
  const { data: last } = await db.from('backup_runs').select('created_at, bytes').eq('scope', 'platform').eq('status', 'ok').order('created_at', { ascending: false }).limit(1);
  let serverKeyOk = false; try { serverKeyOk = !!C.serverKey(env); } catch (_) { serverKeyOk = false; }
  const lastAt = last && last[0] ? last[0].created_at : null;
  return {
    coverage_gaps: gaps.data || [], order_violations: order.data || [], registry_ok: !(gaps.data || []).length && !(order.data || []).length,
    last_platform_backup: lastAt, hours_since_platform_backup: lastAt ? Math.round((now.getTime() - new Date(lastAt).getTime()) / 3600000) : null,
    server_key_configured: serverKeyOk,
  };
}

/** Raises an alert at most once every 24h per key, using the job-state table the nightly job already has. */
async function alertOncePerDay(db, key, now, raise) {
  const store = createJobStateStore(db, { now: () => now });
  const st = await store.load(key);
  if (st.last_lag_alert_at && now.getTime() - new Date(st.last_lag_alert_at).getTime() < 24 * 3600000) return false;
  await raise(); await store.save(key, { last_lag_alert_at: now.toISOString() });
  return true;
}

/** Maps a BackupError to an HTTP status for the endpoints. */
function httpStatusFor(e) {
  const m = { WEAK_PASSPHRASE: 400, PASSPHRASE_REQUIRED: 400, BAD_REQUEST: 400, CONFIRM_REQUIRED: 400, NOT_A_BACKUP: 400, UNSUPPORTED: 400, DECRYPT_FAILED: 422, CORRUPT: 422, KEY_REQUIRED: 422,
    WRONG_SOCIETY: 409, SCHEMA_DRIFT: 409, NOT_AVAILABLE: 404, RESTORE_REFUSED: 409, SNAPSHOT_FAILED: 500, RESTORE_FAILED: 500, TOO_LARGE: 413, BAD_SERVER_KEY: 500 };
  return m[e && e.code] || 500;
}

module.exports = { createBackup, prepareDownload, restoreSociety, listBackups, societiesDue, platformBackupDue, applyRetention, healthReport, alertOncePerDay, httpStatusFor,
  downloadObject, fileNameFor, rowsOf, BUCKET, KEEP, DUE_AFTER_HOURS };
