/**
 * zillion/backend/tests/test-backup.js
 *
 * Tests coopBackupCrypto.js (the .zbk file format) and coopBackup.js (create/restore/retention/health) against a
 * self-contained fake of the two things the real database provides: RPC calls (backup_export_society etc, faked
 * here as plain JS over an in-memory table set — the SQL itself is proven separately, against real staging and
 * production data, in the session that wrote db/migrations/2026-09-28_backup_restore.sql) and Storage
 * (upload/download/remove/signed URL, faked as an in-memory Map). This lets the orchestration logic in
 * coopBackup.js — verify-after-write, the mandatory pre-restore snapshot, retention, due-society detection —
 * be exercised honestly without a live Supabase connection.
 * Run: node backend/tests/test-backup.js
 */
'use strict';
const path = require('path');
const LIB = path.join(__dirname, '..', 'lib');
const C = require(path.join(LIB, 'coopBackupCrypto'));
const backup = require(path.join(LIB, 'coopBackup'));

let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };
let throws;
throws = async (fn, codeOrMsg) => { try { await fn(); return null; } catch (e) { const hay = `${e.code || ''} ${e.message || ''}`; return hay.includes(codeOrMsg) ? true : `wrong error: ${hay}`; } };

// ────────────────────────────── coopBackupCrypto ──────────────────────────────
(() => {
  const text = JSON.stringify({ hello: 'world', n: [1, 2, 3] });
  const plain = C.seal(text, {});
  ok('gzip-only: inspect reports unencrypted', C.inspect(plain.buffer).encrypted === false);
  ok('gzip-only: round-trips', C.open(plain.buffer, {}).text === text);

  const pass = C.seal(text, { passphrase: 'correct horse battery staple' });
  ok('passphrase: round-trips', C.open(pass.buffer, { passphrase: 'correct horse battery staple' }).text === text);
  ok('passphrase: sha256 matches', C.open(pass.buffer, { passphrase: 'correct horse battery staple' }).sha256 === pass.sha256);
  let wrongThrew = false; try { C.open(pass.buffer, { passphrase: 'totally wrong passphrase' }); } catch (e) { wrongThrew = e.code === 'DECRYPT_FAILED'; }
  ok('passphrase: wrong passphrase throws DECRYPT_FAILED', wrongThrew);

  let weakThrew = false; try { C.seal(text, { passphrase: 'short' }); } catch (e) { weakThrew = e.code === 'WEAK_PASSPHRASE'; }
  ok('passphrase: too-short passphrase is refused at seal time', weakThrew);

  const key = require('crypto').randomBytes(32);
  const withKey = C.seal(text, { key });
  ok('server key: round-trips', C.open(withKey.buffer, { key }).text === text);
  let keyReq = false; try { C.open(withKey.buffer, {}); } catch (e) { keyReq = e.code === 'KEY_REQUIRED'; }
  ok('server key: missing key on open throws KEY_REQUIRED', keyReq);

  const tampered = Buffer.from(pass.buffer); tampered[tampered.length - 1] ^= 0xFF;
  let tamperThrew = false; try { C.open(tampered, { passphrase: 'correct horse battery staple' }); } catch (e) { tamperThrew = e.code === 'DECRYPT_FAILED'; }
  ok('AAD binding: a single flipped byte in the ciphertext is detected, not silently decrypted', tamperThrew);

  const tamperedHeader = Buffer.from(pass.buffer); tamperedHeader[5] ^= 0xFF; // flip a byte of the salt
  let headerThrew = false; try { C.open(tamperedHeader, { passphrase: 'correct horse battery staple' }); } catch (e) { headerThrew = e.code === 'DECRYPT_FAILED'; }
  ok('AAD binding: a flipped header byte (salt) is also detected', headerThrew);

  let notBackup = false; try { C.inspect(Buffer.from('not a backup file')); } catch (e) { notBackup = e.code === 'NOT_A_BACKUP'; }
  ok('inspect: garbage input is rejected as NOT_A_BACKUP', notBackup);
})();

// ────────────────────────────── fake db (rpc + storage) ──────────────────────────────
function makeFakeDb() {
  const societies = { 'C1': { coop_id: 'C1', name: 'Alpha Coop' }, 'C2': { coop_id: 'C2', name: 'Beta Coop' } };
  const societyData = { C1: { coop_members: [{ id: 'm1', coop_id: 'C1', name: 'Ada' }] }, C2: { coop_members: [{ id: 'm2', coop_id: 'C2', name: 'Bello' }] } };
  const platformTables = { coop_members: [{ id: 'm1', coop_id: 'C1', name: 'Ada' }, { id: 'm2', coop_id: 'C2', name: 'Bello' }] };
  const backupRuns = []; let runSeq = 1;
  const store = new Map();          // path -> Buffer
  const jobState = new Map();

  const exportSociety = coopId => {
    if (!societies[coopId]) throw new Error(`Society ${coopId} not found`);
    const tables = societyData[coopId] || {};
    const counts = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length]));
    const columns = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length ? Object.keys(v[0]) : ['id', 'coop_id', 'name']]));
    return JSON.stringify({ format: 'zillion-backup', version: 1, scope: 'society', coop_id: coopId, created_at: new Date().toISOString(), tables, counts, columns });
  };
  const restoreSociety = (coopId, payloadText, apply) => {
    const v = JSON.parse(payloadText);
    if (v.format !== 'zillion-backup' || v.version !== 1) throw new Error('This is not a Zillion backup file, or it is a version this system cannot read');
    if (v.scope !== 'society') throw new Error(`This is a ${v.scope} backup, not a society backup`);
    if (v.coop_id !== coopId) throw new Error(`This backup belongs to society ${v.coop_id}, not ${coopId}`);
    if (!societies[coopId]) throw new Error(`Society ${coopId} not found`);
    const cur = societyData[coopId] || {};
    let add = 0, change = 0, remove = 0; const tables = {};
    for (const [tbl, rows] of Object.entries(v.tables || {})) {
      const curRows = cur[tbl] || [];
      const curIds = new Set(curRows.map(r => r.id));
      const newIds = new Set(rows.map(r => r.id));
      add += rows.filter(r => !curIds.has(r.id)).length;
      remove += curRows.filter(r => !newIds.has(r.id)).length;
      change += rows.filter(r => curIds.has(r.id) && JSON.stringify(curRows.find(c => c.id === r.id)) !== JSON.stringify(r)).length;
      tables[tbl] = { rows_in_backup: rows.length, will_add: rows.filter(r => !curIds.has(r.id)).length, will_change: 0, will_remove: curRows.filter(r => !newIds.has(r.id)).length };
      if (apply) cur[tbl] = rows;
    }
    if (apply) societyData[coopId] = cur;
    return { applied: apply, totals: { add, change, remove }, schema_drift: [], tables };
  };
  const exportPlatform = () => JSON.stringify({ format: 'zillion-backup', version: 1, scope: 'platform', created_at: new Date().toISOString(),
    tables: platformTables, counts: Object.fromEntries(Object.entries(platformTables).map(([k, v]) => [k, v.length])),
    columns: Object.fromEntries(Object.entries(platformTables).map(([k, v]) => [k, v.length ? Object.keys(v[0]) : []])) });

  const db = {
    _societies: societies, _societyData: societyData, _backupRuns: backupRuns, _store: store,
    rpc: async (fn, args) => {
      try {
        if (fn === 'backup_export_society') return { data: exportSociety(args.p_coop_id), error: null };
        if (fn === 'backup_export_platform') return { data: exportPlatform(), error: null };
        if (fn === 'backup_restore_society') return { data: restoreSociety(args.p_coop_id, args.p_payload, args.p_apply), error: null };
        return { data: null, error: { message: 'unknown rpc ' + fn } };
      } catch (e) { return { data: null, error: { message: e.message } }; }
    },
    from: (table) => {
      if (table === 'backup_runs') {
        return {
          insert: (row) => ({ select: () => ({ single: async () => { const r = { id: 'run' + (runSeq++), status: 'running', created_at: new Date().toISOString(), ...row }; backupRuns.push(r); return { data: r, error: null }; } }) }),
          update: (patch) => ({ eq: (col, val) => { const r = backupRuns.find(x => x.id === val); if (r) Object.assign(r, patch); return Promise.resolve({ data: r, error: null }); } }),
          select: () => makeQuery(backupRuns),
        };
      }
      if (table === 'coop_societies') return { select: () => makeQuery(Object.values(societies)) };
      if (table === 'scheduled_job_state') {
        return {
          select: () => ({ eq: (col, val) => ({ maybeSingle: async () => ({ data: jobState.get(val) || null, error: null }) }) }),
          upsert: async (row) => { jobState.set(row.job_key, row); return { error: null }; },
        };
      }
      return makeQuery([]);
    },
    storage: {
      from: () => ({
        upload: async (p, buf) => { if (store.has(p)) return { error: { message: 'exists' } }; store.set(p, Buffer.from(buf)); return { error: null }; },
        download: async (p) => { if (!store.has(p)) return { data: null, error: { message: 'not found' } }; const b = store.get(p); return { data: { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }, error: null }; },
        remove: async (paths) => { paths.forEach(p => store.delete(p)); return { error: null }; },
        createSignedUrl: async (p) => ({ data: { signedUrl: 'https://example/' + encodeURIComponent(p) }, error: null }),
      }),
    },
  };
  return db;
}
function makeQuery(rows) {
  let filtered = rows.slice(); let orderCol = null, orderAsc = true; let lim = null;
  const sorted = () => { const out = filtered.slice(); if (orderCol) out.sort((a, b) => (a[orderCol] > b[orderCol] ? 1 : -1) * (orderAsc ? 1 : -1)); return out; };
  const q = {
    eq: (c, v) => { filtered = filtered.filter(r => r[c] === v); return q; },
    neq: (c, v) => { filtered = filtered.filter(r => r[c] !== v); return q; },
    in: (c, arr) => { filtered = filtered.filter(r => arr.includes(r[c])); return q; },
    gte: (c, v) => { filtered = filtered.filter(r => r[c] >= v); return q; },
    order: (c, o) => { orderCol = c; orderAsc = !(o && o.ascending === false); return q; },
    limit: (n) => { lim = n; return q; },
    maybeSingle: async () => ({ data: sorted()[0] || null, error: null }),
    single: async () => ({ data: sorted()[0] || null, error: sorted()[0] ? null : { message: 'not found' } }),
    range: async (from, to) => ({ data: sorted().slice(from, to + 1), error: null }),
    then: (resolve) => { let out = sorted(); if (lim) out = out.slice(0, lim); resolve({ data: out, error: null }); },
  };
  return q;
}

// ────────────────────────────── coopBackup orchestration ──────────────────────────────
(async () => {
  const SERVER_KEY = require('crypto').randomBytes(32).toString('base64');
  const env = { BACKUP_ENCRYPTION_KEY: SERVER_KEY };

  { // createBackup: happy path, server key, verify-after-write
    const db = makeFakeDb();
    const { run, buffer, rows } = await backup.createBackup(db, { scope: 'society', coopId: 'C1', kind: 'manual', createdBy: 'test', useServerKey: true, env });
    ok('createBackup: run marked ok', run.status === 'ok');
    ok('createBackup: stored under a path', !!run.storage_path && db._store.has(run.storage_path));
    ok('createBackup: rows counted', rows === 1);
    const reopened = C.open(db._store.get(run.storage_path), { key: C.serverKey(env) });
    ok('createBackup: what is stored actually decrypts back to a valid payload', JSON.parse(reopened.text).coop_id === 'C1');
  }

  { // createBackup: passphrase path, no server key touched
    const db = makeFakeDb();
    const { run } = await backup.createBackup(db, { scope: 'society', coopId: 'C1', kind: 'manual', passphrase: 'a fine long passphrase', env: {} });
    ok('createBackup: passphrase-sealed backups need no server key', run.status === 'ok' && run.key_kind === 'passphrase');
  }

  { // createBackup: a weak passphrase fails BEFORE any row is written
    const db = makeFakeDb();
    const res = await throws(() => backup.createBackup(db, { scope: 'society', coopId: 'C1', passphrase: 'short' }), 'WEAK_PASSPHRASE');
    ok('createBackup: weak passphrase refused', res === true);
    ok('createBackup: no run row left behind by the refused attempt', db._backupRuns.length === 0);
  }

  { // createBackup: unknown society -> failed run, not a silent no-op
    const db = makeFakeDb();
    let threw = false;
    try { await backup.createBackup(db, { scope: 'society', coopId: 'GHOST', passphrase: 'a fine long passphrase' }); } catch (e) { threw = /not found/.test(e.message); }
    ok('createBackup: unknown society throws', threw);
    ok('createBackup: the failed run is recorded as failed, not silently dropped', db._backupRuns.some(r => r.status === 'failed'));
  }

  { // prepareDownload: server-key backup is re-sealed under the caller's OWN passphrase, never handed out as server-key or plaintext
    const db = makeFakeDb();
    const { run } = await backup.createBackup(db, { scope: 'society', coopId: 'C1', kind: 'manual', useServerKey: true, env });
    const dl = await backup.prepareDownload(db, run, { passphrase: 'caller chosen passphrase 1', env });
    const opened = C.inspect(dl.buffer);
    ok('prepareDownload: downloaded copy is passphrase-sealed, not server-key or plaintext', opened.key_kind === 'passphrase');
    ok('prepareDownload: opens with the caller\'s own passphrase', C.open(dl.buffer, { passphrase: 'caller chosen passphrase 1' }).text.includes('C1'));
  }

  { // restoreSociety: dry-run reports the plan, changes nothing
    const db = makeFakeDb();
    db._societyData.C1.coop_members.push({ id: 'm1-extra', coop_id: 'C1', name: 'Extra' });
    const { run } = await backup.createBackup(db, { scope: 'society', coopId: 'C1', passphrase: 'restore test passphrase' });
    db._societyData.C1.coop_members = [{ id: 'm1', coop_id: 'C1', name: 'Ada-CHANGED' }]; // damage after the backup was taken
    const preview = await backup.restoreSociety(db, { coopId: 'C1', societyName: 'Alpha Coop', run, passphrase: 'restore test passphrase', apply: false });
    ok('restoreSociety: dry-run does not apply', preview.applied === false);
    ok('restoreSociety: dry-run sees the damage (add/remove reported)', preview.plan.totals.add >= 1 || preview.plan.totals.remove >= 1);
    ok('restoreSociety: dry-run changes nothing in the data', db._societyData.C1.coop_members[0].name === 'Ada-CHANGED');
  }

  { // restoreSociety: apply requires exact typed confirmation
    const db = makeFakeDb();
    const { run } = await backup.createBackup(db, { scope: 'society', coopId: 'C1', passphrase: 'restore test passphrase' });
    const res = await throws(() => backup.restoreSociety(db, { coopId: 'C1', societyName: 'Alpha Coop', run, passphrase: 'restore test passphrase', apply: true, confirm: 'RESTORE Wrong Name' }), 'CONFIRM_REQUIRED');
    ok('restoreSociety: wrong confirmation text refused', res === true);
    const res2 = await throws(() => backup.restoreSociety(db, { coopId: 'C1', societyName: 'Alpha Coop', run, passphrase: 'restore test passphrase', apply: true }), 'CONFIRM_REQUIRED');
    ok('restoreSociety: missing confirmation refused', res2 === true);
  }

  { // restoreSociety: apply takes a pre_restore snapshot FIRST, and it is a real, separate backup
    const db = makeFakeDb();
    const { run } = await backup.createBackup(db, { scope: 'society', coopId: 'C1', passphrase: 'restore test passphrase' });
    const before = db._backupRuns.length;
    const result = await backup.restoreSociety(db, { coopId: 'C1', societyName: 'Alpha Coop', run, passphrase: 'restore test passphrase', apply: true, confirm: 'RESTORE Alpha Coop' });
    ok('restoreSociety: applied', result.applied === true);
    ok('restoreSociety: an undo backup id is returned', !!result.undo_backup_id);
    const snap = db._backupRuns.find(r => r.id === result.undo_backup_id);
    ok('restoreSociety: the undo snapshot is a real pre_restore-kind backup, not a label', snap && snap.kind === 'pre_restore' && snap.status === 'ok');
    ok('restoreSociety: exactly one extra run was created (the snapshot)', db._backupRuns.length === before + 1);
  }

  { // restoreSociety: a backup from one society can never be applied to another
    const db = makeFakeDb();
    const { run } = await backup.createBackup(db, { scope: 'society', coopId: 'C1', passphrase: 'restore test passphrase' });
    const res = await throws(() => backup.restoreSociety(db, { coopId: 'C2', societyName: 'Beta Coop', run: { ...run, coop_id: 'C1' }, passphrase: 'restore test passphrase', apply: false }), 'WRONG_SOCIETY');
    ok('restoreSociety: cross-society restore refused', res === true);
  }

  { // restoreSociety: a platform backup cannot masquerade as a society backup
    const db = makeFakeDb();
    const { run: platformRun, buffer } = await backup.createBackup(db, { scope: 'platform', passphrase: 'restore test passphrase' });
    const fakeRun = { ...platformRun, scope: 'society', coop_id: 'C1' };
    const res = await throws(() => backup.restoreSociety(db, { coopId: 'C1', societyName: 'Alpha Coop', run: fakeRun, passphrase: 'restore test passphrase', apply: false }), 'not a society backup');
    ok('restoreSociety: a platform-scope payload is refused for a society restore', res === true);
  }

  { // societiesDue / platformBackupDue
    const db = makeFakeDb();
    const now = new Date();
    let due = await backup.societiesDue(db, ['C1', 'C2'], now);
    ok('societiesDue: both societies due when nothing has been backed up yet', due.has('C1') && due.has('C2'));
    await backup.createBackup(db, { scope: 'society', coopId: 'C1', kind: 'scheduled', passphrase: 'a fine long passphrase', now: () => now });
    due = await backup.societiesDue(db, ['C1', 'C2'], now);
    ok('societiesDue: a society with a fresh scheduled backup drops off the due list', !due.has('C1') && due.has('C2'));
    let platDue = await backup.platformBackupDue(db, now);
    ok('platformBackupDue: true when no platform backup exists yet', platDue === true);
    await backup.createBackup(db, { scope: 'platform', kind: 'scheduled', passphrase: 'a fine long passphrase', now: () => now });
    platDue = await backup.platformBackupDue(db, now);
    ok('platformBackupDue: false right after a scheduled one succeeds', platDue === false);
    const later = new Date(now.getTime() + 21 * 3600000);
    platDue = await backup.platformBackupDue(db, later);
    ok('platformBackupDue: due again after the staleness window (20h) passes', platDue === true);
  }

  { // httpStatusFor mapping
    ok('httpStatusFor: WRONG_SOCIETY -> 409', backup.httpStatusFor(new C.BackupError('WRONG_SOCIETY', 'x')) === 409);
    ok('httpStatusFor: WEAK_PASSPHRASE -> 400', backup.httpStatusFor(new C.BackupError('WEAK_PASSPHRASE', 'x')) === 400);
    ok('httpStatusFor: DECRYPT_FAILED -> 422', backup.httpStatusFor(new C.BackupError('DECRYPT_FAILED', 'x')) === 422);
    ok('httpStatusFor: unrecognised code -> 500', backup.httpStatusFor(new C.BackupError('SOMETHING_NEW', 'x')) === 500);
  }

  console.log(bad ? `\n${bad} FAILURE(S)` : '\nAll backup tests passed.');
})();
