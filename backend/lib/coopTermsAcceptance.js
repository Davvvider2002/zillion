/**
 * zillion/backend/lib/coopTermsAcceptance.js
 *
 * Records consent to Terms & Conditions / Privacy Policy as an
 * append-only audit log — never overwritten, so there's always a
 * true record of who agreed, when, and to which version of the
 * documents (both pages currently version themselves by their
 * "Last updated" date, which is what's stored here).
 */
'use strict';

const CURRENT_TERMS_VERSION = '2026-08-27';
const CURRENT_PRIVACY_VERSION = '2026-08-27';

/**
 * @param {object} db  Supabase client
 * @param {object} params
 * @param {'society_admin'|'member'} params.acceptedByType
 * @param {string} params.acceptedById  coop_id (society admin) or member's zillion_id/phone (member)
 * @param {string} [params.coopId]
 * @param {string} [params.ipAddress]
 */
async function recordTermsAcceptance(db, { acceptedByType, acceptedById, coopId, ipAddress }) {
  try {
    const { error } = await db.from('coop_terms_acceptances').insert({
      accepted_by_type: acceptedByType,
      accepted_by_id: acceptedById,
      coop_id: coopId || null,
      terms_version: CURRENT_TERMS_VERSION,
      privacy_version: CURRENT_PRIVACY_VERSION,
      ip_address: ipAddress || null,
    });
    if (error) {
      console.error('[coopTermsAcceptance] insert failed:', error.message);
      return { recorded: false };
    }
    return { recorded: true };
  } catch (e) {
    console.error('[coopTermsAcceptance] non-fatal error:', e.message);
    return { recorded: false };
  }
}

/** Best-effort IP extraction from a Netlify Functions event. */
function getClientIp(event) {
  return event.headers['x-nf-client-connection-ip']
    || (event.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || null;
}

module.exports = { recordTermsAcceptance, getClientIp, CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION };
