/**
 * zillion/backend/lib/cors.js
 *
 * Shared CORS origin allowlist. Previously several functions used
 * Access-Control-Allow-Origin: '*', letting any website's JavaScript
 * call these endpoints. None of them have a genuine need for arbitrary
 * cross-origin access — all real traffic comes from Zillion's own apps,
 * which call their own backend via same-origin relative paths anyway
 * (no CORS header is even consulted for those). This only matters for
 * actual cross-origin callers, which should be limited to Zillion's own
 * domains.
 */
'use strict';

const ALLOWED_ORIGINS = [
  'https://zillion.ng',
  'https://www.zillion.ng',
  'https://app.zillion.ng',
  'https://zillion-mvp.netlify.app', // legacy — remove once domain migration is fully complete
];

/**
 * @param {object} event  Netlify function event
 * @returns {string} the Origin header value to echo back if it's on the
 *   allowlist, otherwise the primary domain (safe default — rejects the
 *   actual cross-origin request via the browser's own CORS enforcement
 *   without needing extra logic here).
 */
function corsOrigin(event) {
  const reqOrigin = (event && event.headers && (event.headers.origin || event.headers.Origin)) || '';
  return ALLOWED_ORIGINS.includes(reqOrigin) ? reqOrigin : ALLOWED_ORIGINS[0];
}

module.exports = { corsOrigin, ALLOWED_ORIGINS };
