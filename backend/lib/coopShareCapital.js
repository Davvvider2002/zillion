/**
 * zillion/backend/lib/coopShareCapital.js
 *
 * A member's total paid-up share capital - the running sum of every
 * contribution ever recorded against them, same "never a separately
 * stored figure that could drift" philosophy as savings and dues.
 *
 * Deliberately simple: no "share plan" or target concept, unlike
 * savings plans. Cooperative share capital is typically just "how
 * much have you paid in," not goal-based the way a savings target is.
 */
'use strict';

async function computeMemberShareCapital(db, memberId) {
  const { data: txns } = await db.from('coop_share_transactions').select('amount_kobo').eq('member_id', memberId);
  return (txns || []).reduce((s, t) => s + t.amount_kobo, 0);
}

module.exports = { computeMemberShareCapital };
