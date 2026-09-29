/**
 * zillion/backend/lib/coopDojahNin.js
 *
 * Dojah NIN lookup for coop-member KYC. NOT the same integration as backend/netlify/functions/kyc-verify-nin.js
 * (that one calls a Paystack endpoint that, on inspection, does not exist in Paystack's API at all - see the
 * DOJAH_VS_PAYSTACK note below). This is a fresh, working integration, kept separate: wallet-tier KYC and coop
 * membership KYC are different systems with different consequences for getting it wrong.
 *
 * DOJAH_VS_PAYSTACK: Paystack's complete Verification API surface is Resolve Account Number, Validate Account,
 * and Resolve Card BIN - no NIN product exists there. Dojah's NIN lookup (https://api.dojah.io/api/v1/kyc/nin)
 * is real, documented, and billed per call regardless of outcome - which is exactly the policy agreed for
 * charging societies: bill on every attempt sent to Dojah, matched or not.
 *
 * PRIVACY, two different things stored, never confused:
 *   - the HASH (nin_hash): a salted HMAC-SHA256, kept forever once a member is VERIFIED - proves the NIN was
 *     checked without ever letting the number be recovered from it.
 *   - the CIPHERTEXT (nin_encrypted): what a member submits from their own wallet profile before an admin has
 *     verified it, so the admin doesn't have to ask them for it again. AES-256-GCM under COOP_NIN_ENCRYPTION_KEY
 *     (a server-held key, never derived from anything a member or admin supplies), decrypted only in memory for
 *     the one verification call, and cleared to NULL the moment that call confirms a match - see
 *     coop-portal-member-verify-nin.js. On a mismatch it is deliberately left in place so a retry doesn't need
 *     the member to resubmit.
 *
 * MATCHING: Dojah's basic NIN lookup returns whoever the government has on file for that number - it does not
 * accept an expected name to check against, so the match is our own comparison against the member's name on
 * record. Normalizes case/punctuation and compares by token overlap (order-independent, tolerant of a missing
 * middle name) rather than an exact string match, since "SURNAME FIRSTNAME MIDDLENAME" from Dojah rarely matches
 * "Firstname Surname" as typed by a society admin verbatim.
 */
'use strict';

const { createHmac, createCipheriv, createDecipheriv, randomBytes } = require('crypto');

function mustEnv(name, env = process.env) {
  const v = env[name];
  if (!v) throw new Error(`Server misconfigured: ${name} is not set`);
  return v;
}

function hashNIN(nin, salt) {
  return createHmac('sha256', salt).update(String(nin).trim()).digest('hex');
}

/** AES-256-GCM, key from COOP_NIN_ENCRYPTION_KEY (32 bytes, base64) — a single field, packed as iv|tag|ciphertext, base64. */
function encryptNIN(nin, env = process.env) {
  const key = Buffer.from(mustEnv('COOP_NIN_ENCRYPTION_KEY', env), 'base64');
  if (key.length !== 32) throw new Error('COOP_NIN_ENCRYPTION_KEY must be exactly 32 bytes, base64-encoded (openssl rand -base64 32)');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(nin).trim(), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

function decryptNIN(packed, env = process.env) {
  const key = Buffer.from(mustEnv('COOP_NIN_ENCRYPTION_KEY', env), 'base64');
  const buf = Buffer.from(packed, 'base64');
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

function normalizeName(name) {
  return String(name || '').toUpperCase().replace(/[^A-Z\s]/g, ' ').split(/\s+/).filter(Boolean);
}

/** True if every token of the shorter name appears somewhere in the longer one. */
function namesLikelyMatch(a, b) {
  const ta = normalizeName(a), tb = normalizeName(b);
  if (!ta.length || !tb.length) return false;
  const [shorter, longer] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const longerSet = new Set(longer);
  return shorter.every(tok => longerSet.has(tok));
}

/**
 * Calls Dojah's NIN lookup. Returns { matched, dojahName, reference, costKobo } or throws.
 * DEV MODE: if DOJAH_API_KEY is unset, simulates a successful lookup that matches memberName, so the rest of
 * the flow (billing, ledger, member status) can be exercised without a live Dojah account. Logs loudly on
 * every single call while in this mode - it must never go unnoticed if left on in production by mistake.
 */
async function lookupNIN(nin, { memberName, appId, apiKey, costKobo, env = process.env } = {}) {
  const resolvedAppId = appId || env.DOJAH_APP_ID;
  const resolvedApiKey = apiKey || env.DOJAH_API_KEY;
  const assumedCostKobo = Number.isFinite(costKobo) ? costKobo : parseInt(env.DOJAH_COST_KOBO_PER_CALL || '25', 10);

  if (!resolvedApiKey || !resolvedAppId) {
    console.warn('[coopDojahNin] DEV MODE — DOJAH_APP_ID/DOJAH_API_KEY not set, simulating a Dojah lookup. This must not be active in production.');
    return { matched: true, dojahName: memberName, reference: 'DEV-SIMULATED', costKobo: assumedCostKobo };
  }

  const res = await fetch(`https://api.dojah.io/api/v1/kyc/nin?nin=${encodeURIComponent(nin)}`, {
    method: 'GET',
    headers: { 'AppId': resolvedAppId, 'Authorization': resolvedApiKey },
  });
  const data = await res.json().catch(() => ({}));
  // Dojah bills the call whether it hits or misses, so the cost is booked either way, even on a thrown error below.
  if (!res.ok || data?.entity == null) {
    const message = data?.error || `Dojah lookup failed (${res.status})`;
    throw Object.assign(new Error(message), { costKobo: assumedCostKobo, reference: data?.reference_id || null });
  }
  const e = data.entity;
  const dojahName = [e.first_name, e.middle_name, e.last_name].filter(Boolean).join(' ');
  return { matched: namesLikelyMatch(dojahName, memberName), dojahName, reference: data.reference_id || null, costKobo: assumedCostKobo };
}

module.exports = { hashNIN, encryptNIN, decryptNIN, namesLikelyMatch, lookupNIN, mustEnv };
