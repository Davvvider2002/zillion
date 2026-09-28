/**
 * zillion/backend/lib/coopBackupCrypto.js
 *
 * The backup FILE FORMAT (.zbk). Deliberately dependency-free (Node's crypto and zlib only), so a backup can be opened years
 * from now, on any machine, even if this platform no longer exists - see scripts/backup_tool.js.
 *
 *   'ZBK1' | flag(1) | ...                                       flag 0 = compressed only
 *   'ZBK1' | 1 | salt(16) | iv(12) | tag(16) | ciphertext        flag 1 = AES-256-GCM, key from a passphrase (scrypt)
 *   'ZBK1' | 2 | zeros(16) | iv(12) | tag(16) | ciphertext       flag 2 = AES-256-GCM, key from BACKUP_ENCRYPTION_KEY
 *
 * The plaintext is gzip(JSON). The header is bound into the GCM tag as associated data, so changing ANY byte - header,
 * salt, iv, tag or body - makes decryption fail loudly instead of returning damaged data. A sha256 of the plaintext is
 * recorded separately (backup_runs.sha256) and re-checked, which also covers the unencrypted flavour.
 */
'use strict';

const crypto = require('crypto');
const zlib = require('zlib');

const MAGIC = Buffer.from('ZBK1');
const FLAG_NONE = 0, FLAG_PASS = 1, FLAG_KEY = 2;
const HEADER_LEN = 4 + 1 + 16 + 12;                 // magic, flag, salt, iv
const MIN_PASSPHRASE = 12;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MAX_PLAINTEXT = 512 * 1024 * 1024;

class BackupError extends Error { constructor(code, message) { super(message); this.code = code; } }

const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');

/** The server-held key for scheduled backups: BACKUP_ENCRYPTION_KEY, 32 bytes, base64. Null if not configured. */
function serverKey(env = process.env) {
  const b64 = String(env.BACKUP_ENCRYPTION_KEY || '').trim();
  if (!b64) return null;
  const k = Buffer.from(b64, 'base64');
  if (k.length !== 32) throw new BackupError('BAD_SERVER_KEY', 'BACKUP_ENCRYPTION_KEY must be exactly 32 bytes, base64-encoded (generate one with: openssl rand -base64 32).');
  return k;
}
function checkPassphrase(p) {
  if (typeof p !== 'string' || p.length < MIN_PASSPHRASE) throw new BackupError('WEAK_PASSPHRASE', `The passphrase must be at least ${MIN_PASSPHRASE} characters.`);
}

/** text -> file bytes. Pass a passphrase OR a 32-byte key to encrypt; neither gives compressed-only. */
function seal(text, { passphrase = null, key = null } = {}) {
  const gz = zlib.gzipSync(Buffer.from(text, 'utf8'), { level: 9 });
  const digest = sha256(text);
  if (!passphrase && !key) return { buffer: Buffer.concat([MAGIC, Buffer.from([FLAG_NONE]), gz]), sha256: digest, key_kind: 'none' };
  let k = key, salt = Buffer.alloc(16);
  if (passphrase) { checkPassphrase(passphrase); salt = crypto.randomBytes(16); k = crypto.scryptSync(passphrase, salt, 32, SCRYPT); }
  const iv = crypto.randomBytes(12);
  const header = Buffer.concat([MAGIC, Buffer.from([passphrase ? FLAG_PASS : FLAG_KEY]), salt, iv]);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv); c.setAAD(header);
  const ct = Buffer.concat([c.update(gz), c.final()]);
  return { buffer: Buffer.concat([header, c.getAuthTag(), ct]), sha256: digest, key_kind: passphrase ? 'passphrase' : 'server' };
}

/** What a file is, without decrypting it. */
function inspect(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 5 || !buffer.subarray(0, 4).equals(MAGIC)) throw new BackupError('NOT_A_BACKUP', 'This is not a Zillion backup file.');
  const flag = buffer[4];
  if (![FLAG_NONE, FLAG_PASS, FLAG_KEY].includes(flag)) throw new BackupError('UNSUPPORTED', 'This backup uses a format this version cannot read.');
  return { encrypted: flag !== FLAG_NONE, key_kind: ['none', 'passphrase', 'server'][flag], bytes: buffer.length };
}

/** file bytes -> { text, sha256 }. Throws BackupError with a plain-language message on ANY problem. */
function open(buffer, { passphrase = null, key = null } = {}) {
  const info = inspect(buffer);
  let gz;
  if (!info.encrypted) gz = buffer.subarray(5);
  else {
    if (buffer.length < HEADER_LEN + 16 + 1) throw new BackupError('CORRUPT', 'The backup file is incomplete (it has been cut short).');
    const header = buffer.subarray(0, HEADER_LEN), salt = buffer.subarray(5, 21), iv = buffer.subarray(21, 33), tag = buffer.subarray(33, 49), ct = buffer.subarray(49);
    let k;
    if (buffer[4] === FLAG_PASS) {
      if (!passphrase) throw new BackupError('PASSPHRASE_REQUIRED', 'This backup is protected by a passphrase. Enter the passphrase it was created with.');
      k = crypto.scryptSync(passphrase, salt, 32, SCRYPT);
    } else {
      if (!key) throw new BackupError('KEY_REQUIRED', 'This backup is encrypted with the platform key (BACKUP_ENCRYPTION_KEY), which is not available here.');
      k = key;
    }
    try { const d = crypto.createDecipheriv('aes-256-gcm', k, iv); d.setAAD(header); d.setAuthTag(tag); gz = Buffer.concat([d.update(ct), d.final()]); }
    catch { throw new BackupError('DECRYPT_FAILED', buffer[4] === FLAG_PASS ? 'Wrong passphrase, or the file has been damaged or altered.' : 'This backup could not be decrypted: the key is wrong or the file has been altered.'); }
  }
  let text;
  try { text = zlib.gunzipSync(gz, { maxOutputLength: MAX_PLAINTEXT }).toString('utf8'); }
  catch { throw new BackupError('CORRUPT', 'The backup is damaged: it could not be decompressed.'); }
  return { text, sha256: sha256(text), key_kind: info.key_kind };
}

module.exports = { seal, open, inspect, serverKey, sha256, BackupError, MIN_PASSPHRASE, FLAG_NONE, FLAG_PASS, FLAG_KEY, HEADER_LEN };
