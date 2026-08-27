/**
 * zillion/backend/lib/flutterwave.js
 *
 * Flutterwave v4 uses OAuth 2.0 client_credentials, not a directly-passed
 * secret key — confirmed directly by Flutterwave's own support (both
 * sandbox AND production work this way). Tokens are short-lived (10
 * minutes), so this refreshes proactively rather than waiting for a
 * request to fail.
 *
 * Caching is a plain module-level variable — safe in a stateless
 * environment because a cold start (losing the cache) just means the
 * next call fetches a fresh token instead; there's no correctness risk,
 * only a minor efficiency loss on cold starts. No token is ever cached
 * past its own expiry.
 *
 * Base URL is configurable via FLW_API_BASE_URL specifically because,
 * as of this integration, only the sandbox base URL has been directly
 * confirmed (developersandbox-api.flutterwave.com) — production's exact
 * base URL under v4 hasn't been confirmed yet. Defaulting to sandbox
 * until that's known; switching to production later is then a config
 * change, not a code change.
 */
'use strict';

const TOKEN_URL = 'https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token';

let cachedToken = null;
let cachedTokenExpiresAt = 0; // epoch ms

async function getFlutterwaveAccessToken() {
  const now = Date.now();
  // Refresh at least 60s before actual expiry, matching the buffer
  // Flutterwave's own support explicitly recommended.
  if (cachedToken && now < cachedTokenExpiresAt - 60_000) {
    return cachedToken;
  }

  const clientId     = process.env.FLW_CLIENT_ID;
  const clientSecret = process.env.FLW_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('FLW_CLIENT_ID / FLW_CLIENT_SECRET not configured — v4 credentials required (dashboard: Settings > API Keys > Switch to v4)');
  }

  const params = new URLSearchParams({
    client_id:     clientId,
    client_secret: clientSecret,
    grant_type:    'client_credentials',
  });

  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    params.toString(),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Flutterwave token exchange failed: ${data.error_description || data.error || res.status}`);
  }

  cachedToken = data.access_token;
  cachedTokenExpiresAt = now + (Number(data.expires_in || 600) * 1000);
  return cachedToken;
}

function flutterwaveApiBase() {
  return process.env.FLW_API_BASE_URL || 'https://developersandbox-api.flutterwave.com';
}

module.exports = { getFlutterwaveAccessToken, flutterwaveApiBase };
