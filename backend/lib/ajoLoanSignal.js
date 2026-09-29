/**
 * zillion/backend/lib/ajoLoanSignal.js
 *
 * Surfaces a coop loan applicant's Ajo track record to whoever is reviewing the application — informational
 * only. This never approves, denies, or adjusts loan terms on its own; it just gives a human underwriter one
 * more honest fact to weigh, the same way the loan review screen already shows guarantor status. Whether and
 * how much this should actually influence a real lending decision is a policy call for David, not something
 * to encode here.
 *
 * computeAjoLoanSignalsBulk does ALL applicants in one set of bulk reads (three queries total, regardless of
 * how many loans are being reviewed) — the loan-review screen can list every loan platform-wide with no
 * coop_id filter, so this must not turn into one Ajo lookup per loan.
 */
'use strict';

const { fetchAllRows, chunk } = require('./coopPaginate');

/**
 * @param {object} db
 * @param {Array<string|null>} zillionIds  one per loan applicant (nulls are skipped)
 * @returns {Promise<Map<string, object>>} zillion_id -> signal (only present for members with real Ajo history)
 */
async function computeAjoLoanSignalsBulk(db, zillionIds) {
  const ids = [...new Set(zillionIds.filter(Boolean))];
  const result = new Map();
  if (!ids.length) return result;

  let memberships = [];
  for (const part of chunk(ids)) {
    memberships.push(...await fetchAllRows(() => db.from('ajo_scheme_members')
      .select('id, scheme_id, zillion_id, status, reliability_score, ajo_schemes(name)').in('zillion_id', part).order('id')));
  }
  if (!memberships.length) return result;

  const memberIds = memberships.map(m => m.id);
  let contributions = [];
  for (const part of chunk(memberIds)) {
    contributions.push(...await fetchAllRows(() => db.from('ajo_contributions').select('scheme_member_id, amount_kobo').in('scheme_member_id', part).order('id')));
  }

  const countByMember = new Map(), totalByMember = new Map();
  for (const c of contributions) {
    countByMember.set(c.scheme_member_id, (countByMember.get(c.scheme_member_id) || 0) + 1);
    totalByMember.set(c.scheme_member_id, (totalByMember.get(c.scheme_member_id) || 0) + (c.amount_kobo || 0));
  }

  const byZillionId = new Map();
  for (const m of memberships) { if (!byZillionId.has(m.zillion_id)) byZillionId.set(m.zillion_id, []); byZillionId.get(m.zillion_id).push(m); }

  for (const [zillionId, ms] of byZillionId) {
    const schemes = ms.map(m => ({
      scheme_id: m.scheme_id, scheme_name: m.ajo_schemes?.name || 'Ajo scheme',
      reliability_score: m.reliability_score, contributions_made: countByMember.get(m.id) || 0,
    }));
    const scored = schemes.filter(s => s.reliability_score != null);
    result.set(zillionId, {
      has_ajo_history: true,
      active_scheme_count: ms.filter(m => m.status === 'ACTIVE').length,
      total_contributed_kobo: ms.reduce((s, m) => s + (totalByMember.get(m.id) || 0), 0),
      average_reliability_score: scored.length ? Math.round((scored.reduce((s, x) => s + x.reliability_score, 0) / scored.length) * 100) / 100 : null,
      schemes,
    });
  }
  return result;
}

module.exports = { computeAjoLoanSignalsBulk };
