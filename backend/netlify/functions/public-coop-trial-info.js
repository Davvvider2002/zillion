/**
 * zillion/backend/netlify/functions/public-coop-trial-info.js
 *
 * GET /api/v1/public-coop-trial-info?coop_id=X
 *
 * Public, unauthenticated — deliberately minimal. Lets the landing
 * page show "welcome back, N days left in your trial" and a working
 * "pay now" button when someone returns via their bookmarked link,
 * without needing any login. Returns only what's needed to render
 * that — no phone, no email, no internal identifiers beyond coop_id
 * itself (which the caller already has).
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const coopId = (event.queryStringParameters?.coop_id || '').trim();
  if (!coopId) return err(400, 'coop_id is required');

  const db = getServiceClient();
  const { data: society } = await db.from('coop_societies')
    .select('coop_id, name, subscription_status, subscription_plan, subscription_cycle, subscription_paid_until, trial_ends_at')
    .eq('coop_id', coopId).maybeSingle();
  if (!society) return err(404, 'Not found');

  return ok({
    coop_id: society.coop_id,
    name: society.name,
    subscription_status: society.subscription_status,
    subscription_plan: society.subscription_plan,
    subscription_cycle: society.subscription_cycle,
    subscription_paid_until: society.subscription_paid_until,
    trial_ends_at: society.trial_ends_at,
  });
};
