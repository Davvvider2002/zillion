/**
 * zillion/backend/netlify/functions/public-coop-bundle-info.js
 * GET /api/v1/public-coop-bundle-info?code=...  — what the sign-up page shows for a bundle link (plan name, price, member range, modules).
 * Reveals nothing but the plan the link was issued for, and only while the link is usable.
 */
'use strict';
const { getServiceClient } = require('../../lib/supabase');
const { limitByIp, tooManyRequests } = require('../../lib/publicRateLimit');
const { lookupLink, BUNDLE_ADDON_KEYS } = require('../../lib/coopBundles');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const json = (c, b) => ({ statusCode: c, headers: hdr, body: JSON.stringify(b) });
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });
  const db = getServiceClient();
  const lim = await limitByIp(db, event, 'coop-bundle-info', { windowMinutes: 10, maxAttempts: 30, lockoutMinutes: 15 });
  if (!lim.allowed) return tooManyRequests(lim.retryAfterSeconds, 'requests');
  const found = await lookupLink(db, String((event.queryStringParameters || {}).code || ''));
  if (!found.ok) return json(404, { error: found.error });
  const { data: mods } = await db.from('coop_addon_modules').select('key, name').in('key', BUNDLE_ADDON_KEYS);
  return json(200, {
    tier: found.link.tier, label: found.plan.label, members: found.plan.members, member_cap: found.plan.memberCap,
    yearly_kobo: found.plan.yearlyKobo, modules: (mods || []).map(m => m.name),
  });
};
