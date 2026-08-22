/**
 * zillion/backend/lib/coopSubscription.js
 *
 * Shared subscription date math — tested locally before use anywhere:
 * - extendSubscription: early renewals extend FROM the existing
 *   paid_until (never lose already-paid time), not from "now".
 * - isPastGrace: a 7-day grace period after paid_until before a
 *   society is actually suspended for a failed/missed renewal — no
 *   one loses access the moment a single charge fails.
 */
'use strict';

const GRACE_DAYS = 7;

function extendSubscription(currentPaidUntil, cycle, now = new Date()) {
  const base = (currentPaidUntil && new Date(currentPaidUntil) > now) ? new Date(currentPaidUntil) : now;
  const next = new Date(base);
  if (cycle === 'yearly') next.setFullYear(next.getFullYear() + 1);
  else next.setMonth(next.getMonth() + 1);
  return next;
}

function isPastGrace(paidUntil, now = new Date()) {
  if (!paidUntil) return false;
  const graceEnd = new Date(paidUntil);
  graceEnd.setDate(graceEnd.getDate() + GRACE_DAYS);
  return now > graceEnd;
}

module.exports = { extendSubscription, isPastGrace, GRACE_DAYS };
