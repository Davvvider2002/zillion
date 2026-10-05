/**
 * zillion/backend/lib/publicRateLimit.js
 *
 * Rate limiting for the endpoints anyone on the internet can call (society sign-up, member join, agent applications).
 * A thin, safe wrapper over lib/rateLimit.js, which already guards OTP sending.
 *
 * Two choices worth knowing:
 *  - It FAILS OPEN. If the limiter's own database call breaks, the request is allowed. A limiter outage must never
 *    become a sign-up outage; the limits are protection against abuse, not part of the business logic.
 *  - The IP comes from Netlify's own x-nf-client-connection-ip header, which a caller cannot forge. If no IP can be
 *    determined, the per-IP limit is skipped rather than lumping every unknown caller into one shared bucket.
 *
 * Limits are deliberately generous per IP: mobile networks in Nigeria put many real people behind one address, and a
 * society onboarding its members at a meeting shares one Wi-Fi. They exist to stop floods, not to ration people.
 */
'use strict';

const { checkRateLimit } = require('./rateLimit');
const { getClientIp } = require('./coopTermsAcceptance');

async function limit(db, key, opts) {
  try { return await checkRateLimit(db, key, opts); }
  catch (e) { console.error('[publicRateLimit] limiter failed, allowing the request:', e.message); return { allowed: true }; }
}

/** Per-caller-address limit. */
async function limitByIp(db, event, scope, opts) {
  const ip = getClientIp(event);
  if (!ip) return { allowed: true };
  return limit(db, `${scope}:ip:${ip}`, opts);
}

/** Per-identifier limit (a phone number, an email). */
async function limitByKey(db, scope, id, opts) {
  return limit(db, `${scope}:key:${id}`, opts);
}

function humanWait(seconds) {
  if (seconds >= 7200) return `${Math.ceil(seconds / 3600)} hours`;
  if (seconds >= 120) return `${Math.ceil(seconds / 60)} minutes`;
  return 'a minute';
}

/** A ready-made 429 response. */
function tooManyRequests(retryAfterSeconds, what) {
  return {
    statusCode: 429,
    headers: { 'Content-Type': 'application/json', 'Retry-After': String(retryAfterSeconds || 60) },
    body: JSON.stringify({ error: `Too many ${what} from this connection. Please try again in ${humanWait(retryAfterSeconds || 60)}, or contact support if you need help.` }),
  };
}

module.exports = { limitByIp, limitByKey, tooManyRequests };
