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
 * PRIVACY: the raw NIN is only ever held in memory for the one call to Dojah. What gets stored is a salted
 * HMAC-SHA256 hash (COOP_NIN_HASH_SALT) - never the number itself, mirroring the wallet-tier convention.
 *
 * MATCHING: Dojah's basic NIN lookup returns whoever the government has on file for that number - it does not
 * accept an expected name to check against, so the match is our own comparison against the member's name on
 * record. Normalizes case/punctuation and compares by token overlap (order-independent, tolerant of a missing
 * middle name) rather than an exact string match, since "SURNAME FIRSTNAME MIDDLENAME" from Dojah rarely matches
 * "Firstname Surname" as typed by a society admin verbatim.
 */
'use strict';

const { createHmac } = require('crypto');

function mustEnv(name, env = process.env) {
  const v = env[name];
  if (!v) throw new Error(`Server misconfigured: ${name} is not set`);
  return v;
}

function hashNIN(nin, salt) {
  return createHmac('sha256', salt).update(String(nin).trim()).digest('hex');
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

module.exports = { hashNIN, namesLikelyMatch, lookupNIN, mustEnv };
