/**
 * zillion/backend/lib/rateLimit.js
 *
 * Simple attempt-counter rate limiting, backed by Supabase since Netlify
 * Functions are stateless (no in-memory counter survives between
 * invocations). Used for admin-login, verify-otp, and sync — the
 * money/identity-adjacent surface that previously had zero throttling.
 */
'use strict';

const DEFAULT_WINDOW_MINUTES  = 15; // attempts counted within this rolling window
const DEFAULT_MAX_ATTEMPTS    = 5;  // after this many, lock out
const DEFAULT_LOCKOUT_MINUTES = 15; // how long a lockout lasts

/**
 * @param {object} db  Supabase client (service role)
 * @param {string} key  identifier, e.g. `admin-login:${ip}:${username}`
 * @param {object} [opts]
 * @param {number} [opts.windowMinutes]
 * @param {number} [opts.maxAttempts]
 * @param {number} [opts.lockoutMinutes]
 * @returns {Promise<{allowed:boolean, retryAfterSeconds?:number}>}
 */
async function checkRateLimit(db, key, opts = {}) {
  const WINDOW_MINUTES  = opts.windowMinutes  ?? DEFAULT_WINDOW_MINUTES;
  const MAX_ATTEMPTS    = opts.maxAttempts    ?? DEFAULT_MAX_ATTEMPTS;
  const LOCKOUT_MINUTES = opts.lockoutMinutes ?? DEFAULT_LOCKOUT_MINUTES;

  const now = new Date();
  const { data: row } = await db.from('rate_limit_attempts')
    .select('*').eq('rate_key', key).maybeSingle();

  if (row && row.locked_until && new Date(row.locked_until) > now) {
    const retryAfterSeconds = Math.ceil((new Date(row.locked_until) - now) / 1000);
    return { allowed: false, retryAfterSeconds };
  }

  const windowExpired = !row || (now - new Date(row.window_start)) > WINDOW_MINUTES * 60 * 1000;
  const nextCount = windowExpired ? 1 : (row.attempt_count + 1);

  if (nextCount > MAX_ATTEMPTS) {
    const lockedUntil = new Date(now.getTime() + LOCKOUT_MINUTES * 60 * 1000);
    await db.from('rate_limit_attempts').upsert({
      rate_key: key, attempt_count: nextCount,
      window_start: windowExpired ? now.toISOString() : row.window_start,
      locked_until: lockedUntil.toISOString(), updated_at: now.toISOString(),
    });
    return { allowed: false, retryAfterSeconds: LOCKOUT_MINUTES * 60 };
  }

  await db.from('rate_limit_attempts').upsert({
    rate_key: key, attempt_count: nextCount,
    window_start: windowExpired ? now.toISOString() : row.window_start,
    locked_until: null, updated_at: now.toISOString(),
  });
  return { allowed: true };
}

/** Call on successful auth to reset the counter for that key. */
async function resetRateLimit(db, key) {
  await db.from('rate_limit_attempts').delete().eq('rate_key', key);
}

module.exports = { checkRateLimit, resetRateLimit };
