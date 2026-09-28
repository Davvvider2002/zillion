#!/usr/bin/env node
/**
 * zillion/scripts/backup_tool.js
 *
 * Command-line fallback for backups too large for the admin panel (the panel's inline download caps at ~3MB;
 * Netlify's own response limit is 6MB), and the ONLY way to load a platform backup — that is intentional, see
 * backend/netlify/functions/admin-backup-restore-preview.js.
 *
 * Needs: SUPABASE_URL, SUPABASE_SERVICE_KEY (talks to the database directly, not through the website) and,
 * for encrypted files, either --passphrase or BACKUP_ENCRYPTION_KEY in the environment.
 *
 * Usage:
 *   node scripts/backup_tool.js export-society <coop_id> <out.zbk> [--passphrase "..."] [--server-key]
 *   node scripts/backup_tool.js export-platform <out.zbk>          [--passphrase "..."] [--server-key]
 *   node scripts/backup_tool.js inspect <file.zbk>
 *   node scripts/backup_tool.js load-platform <file.zbk> --schema <name> [--apply] [--passphrase "..."] [--server-key]
 *
 * load-platform only ever INSERTs into a schema that does not conflict with existing rows (ON CONFLICT DO
 * NOTHING) — see backup_load_platform() in the migration. To rebuild a whole database from nothing:
 *   1. create the empty database / project
 *   2. apply the schema (supabase db dump --schema-only, or replay the migrations in db/migrations/)
 *   3. node scripts/backup_tool.js load-platform platform.zbk --schema public --apply
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const C = require('../backend/lib/coopBackupCrypto');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { out[key] = true; } else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function db() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) { console.error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY first.'); process.exit(1); }
  return createClient(url, key, { auth: { persistSession: false } });
}

function keyOpts(args) {
  if (args.passphrase) return { passphrase: String(args.passphrase) };
  if (args['server-key']) return { key: C.serverKey(process.env) };
  return {};
}

async function exportSociety(coopId, outPath, args) {
  const { data, error } = await db().rpc('backup_export_society', { p_coop_id: coopId });
  if (error) { console.error('Export failed:', error.message); process.exit(1); }
  const sealed = C.seal(data, keyOpts(args));
  fs.writeFileSync(outPath, sealed.buffer);
  console.log(`Wrote ${outPath} (${sealed.buffer.length} bytes, sha256 ${sealed.sha256.slice(0, 16)}...)`);
}

async function exportPlatform(outPath, args) {
  const { data, error } = await db().rpc('backup_export_platform');
  if (error) { console.error('Export failed:', error.message); process.exit(1); }
  const sealed = C.seal(data, keyOpts(args));
  fs.writeFileSync(outPath, sealed.buffer);
  console.log(`Wrote ${outPath} (${sealed.buffer.length} bytes, sha256 ${sealed.sha256.slice(0, 16)}...)`);
}

function inspectFile(filePath) {
  const buf = fs.readFileSync(filePath);
  const info = C.inspect(buf);
  console.log(`${path.basename(filePath)}: ${info.bytes} bytes, encrypted=${info.encrypted}, key_kind=${info.key_kind}`);
  if (!info.encrypted) {
    const { text } = C.open(buf, {});
    const j = JSON.parse(text);
    console.log(`  scope=${j.scope} coop_id=${j.coop_id || '(platform)'} created_at=${j.created_at} tables=${Object.keys(j.tables).length} rows=${Object.values(j.counts).reduce((a, b) => a + b, 0)}`);
  } else {
    console.log('  (encrypted — use inspect with --passphrase to see the contents, or just proceed to load-platform)');
  }
}

async function loadPlatform(filePath, args) {
  if (!args.schema) { console.error('--schema is required (the target schema to load into — should be empty).'); process.exit(1); }
  const buf = fs.readFileSync(filePath);
  const { text } = C.open(buf, keyOpts(args));
  const client = db();
  const { data, error } = await client.rpc('backup_load_platform', { p_payload: text, p_schema: args.schema, p_apply: !!args.apply });
  if (error) { console.error('Load failed:', error.message); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
  if (!args.apply) console.log('\nThis was a DRY RUN (nothing was written). Add --apply to actually load.');
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);
  try {
    if (cmd === 'export-society') { const [coopId, out] = args._; if (!coopId || !out) throw new Error('usage: export-society <coop_id> <out.zbk>'); await exportSociety(coopId, out, args); }
    else if (cmd === 'export-platform') { const [out] = args._; if (!out) throw new Error('usage: export-platform <out.zbk>'); await exportPlatform(out, args); }
    else if (cmd === 'inspect') { const [file] = args._; if (!file) throw new Error('usage: inspect <file.zbk>'); inspectFile(file); }
    else if (cmd === 'load-platform') { const [file] = args._; if (!file) throw new Error('usage: load-platform <file.zbk> --schema <name> [--apply]'); await loadPlatform(file, args); }
    else {
      console.log('Usage:\n  export-society <coop_id> <out.zbk> [--passphrase P | --server-key]\n  export-platform <out.zbk> [--passphrase P | --server-key]\n  inspect <file.zbk>\n  load-platform <file.zbk> --schema <name> [--apply] [--passphrase P | --server-key]');
      process.exit(cmd ? 1 : 0);
    }
  } catch (e) {
    if (e instanceof C.BackupError) console.error(`${e.code}: ${e.message}`); else console.error(e.message);
    process.exit(1);
  }
}

main();
