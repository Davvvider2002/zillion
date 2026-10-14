/**
 * zillion/backend/lib/coopBundles.js
 *
 * The Micro and Starter bundles: core modules + Accounting & Finance + Bank Reconciliation + Shares & Dividends, sold as one yearly price
 * for small societies. They are NOT on the public landing page and cannot be picked at public sign-up: a society only gets one through
 * a single-use link that Zillion Admin issues (usually after an agent asks for it). Yearly only, no monthly option.
 *
 * Prices and member caps live in coop_subscription_plan_catalog (like every other plan) so the cap enforcement and billing work unchanged;
 * the figures below are what the migration seeds and what the tests pin.
 */
'use strict';
const crypto = require('crypto');

const BUNDLE_TIERS = {
  micro_bundle:   { label: 'Micro Bundle',   members: '1-50',   memberCap: 50,  yearlyKobo: 10000000 },  // ₦100,000
  starter_bundle: { label: 'Starter Bundle', members: '51-100', memberCap: 100, yearlyKobo: 18000000 },  // ₦180,000
};
const BUNDLE_ADDON_KEYS = ['accounting', 'bank_reconciliation', 'surplus_dividends'];
const BUNDLE_CYCLE = 'yearly';
const LINK_VALID_DAYS = 30;

const isBundleTier = t => Object.prototype.hasOwnProperty.call(BUNDLE_TIERS, t);
/** A bundle society always holds its three included modules; other plans keep exactly the add-ons chosen. */
const addonKeysFor = (tier, keys = []) => [...new Set([...(isBundleTier(tier) ? BUNDLE_ADDON_KEYS : []), ...keys.filter(Boolean)])];
const isIncludedInBundle = (tier, key) => isBundleTier(tier) && BUNDLE_ADDON_KEYS.includes(key);

function newLinkCode() { return crypto.randomBytes(24).toString('base64url'); }
const validCodeShape = c => typeof c === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(c);

/**
 * Look a link up and say whether it can be used right now. Never throws; an unknown code and a used one look the same to the caller
 * except for the message, so the response does not confirm which codes exist beyond "usable or not".
 */
async function lookupLink(db, code) {
  if (!validCodeShape(code)) return { ok: false, error: 'This sign-up link is not valid.' };
  const { data: link } = await db.from('coop_bundle_links').select('*').eq('code', code).maybeSingle();
  if (!link) return { ok: false, error: 'This sign-up link is not valid.' };
  if (link.revoked_at) return { ok: false, error: 'This sign-up link has been cancelled. Please ask your Zillion agent for a new one.' };
  if (link.used_at) return { ok: false, error: 'This sign-up link has already been used.' };
  if (new Date(link.expires_at).getTime() < Date.now()) return { ok: false, error: 'This sign-up link has expired. Please ask your Zillion agent for a new one.' };
  if (!isBundleTier(link.tier)) return { ok: false, error: 'This sign-up link is not valid.' };
  return { ok: true, link, plan: BUNDLE_TIERS[link.tier] };
}

/** Claim a link for one society, atomically: only one caller can flip used_at from null. */
async function claimLink(db, linkId, coopId) {
  const { data } = await db.from('coop_bundle_links').update({ used_at: new Date().toISOString(), used_by_coop_id: coopId || null })
    .eq('id', linkId).is('used_at', null).is('revoked_at', null).select('id');
  return Array.isArray(data) && data.length === 1;
}
async function releaseLink(db, linkId) { await db.from('coop_bundle_links').update({ used_at: null, used_by_coop_id: null }).eq('id', linkId); }

module.exports = { BUNDLE_TIERS, BUNDLE_ADDON_KEYS, BUNDLE_CYCLE, LINK_VALID_DAYS, isBundleTier, addonKeysFor, isIncludedInBundle, newLinkCode, validCodeShape, lookupLink, claimLink, releaseLink };
