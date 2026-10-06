/**
 * zillion/backend/lib/adminTotp.js
 *
 * RFC 6238 time-based one-time passwords (HMAC-SHA1, 30-second steps, 6 digits, accepting one step either side for clock
 * drift) - the same algorithm admin login uses, here for STEP-UP checks: actions that move money ask for a fresh
 * authenticator code even though the person is already signed in, so a stolen or left-open session cannot approve a payout.
 *
 * Verified against the official RFC 6238 test vectors in tests/test-flutterwave-payouts.js.
 */
'use strict';

const { createHmac, timingSafeEqual } = require('crypto');

function b32decode(s) {
  const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  s = String(s).replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0, val = 0; const out = [];
  for (const c of s) {
    const idx = ALPHA.indexOf(c); if (idx < 0) continue;
    val = (val << 5) | idx; bits += 5;
    if (bits >= 8) { bits -= 8; out.push((val >> bits) & 0xFF); }
  }
  return Buffer.from(out);
}

function computeTOTP(secret, unixSeconds) {
  const ctr = Math.floor(unixSeconds / 30);
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(ctr / 0x100000000), 0);
  msg.writeUInt32BE(ctr >>> 0, 4);
  const h = createHmac('sha1', b32decode(secret)).update(msg).digest();
  const off = h[h.length - 1] & 0x0F;
  return String((h.readUInt32BE(off) & 0x7FFFFFFF) % 1000000).padStart(6, '0');
}

/** True only for a well-formed 6-digit code that matches the secret now (+/- one 30s step). Constant-time comparison. */
function verifyTOTP(secret, code, nowMs = Date.now()) {
  if (!secret || !/^\d{6}$/.test(String(code || '').replace(/\s+/g, ''))) return false;
  const given = Buffer.from(String(code).replace(/\s+/g, ''));
  const now = Math.floor(nowMs / 1000);
  let ok = false;
  for (let d = -1; d <= 1; d++) {
    const want = Buffer.from(computeTOTP(secret, now + d * 30));
    if (want.length === given.length && timingSafeEqual(want, given)) ok = true;   // no early exit: every window is always checked
  }
  return ok;
}

module.exports = { computeTOTP, verifyTOTP, b32decode };
