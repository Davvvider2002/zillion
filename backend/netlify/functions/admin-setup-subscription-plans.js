/**
 * zillion/backend/netlify/functions/admin-setup-subscription-plans.js
 *
 * POST /api/v1/admin-setup-subscription-plans
 *
 * One-time setup: creates the 6 Flutterwave Payment Plans (3 tiers ×
 * monthly/yearly) and stores their IDs in coop_subscription_plan_catalog.
 * Idempotent — safe to call multiple times, skips any row that already
 * has a flutterwave_plan_id.
 *
 * "yearly" confirmed as the correct interval string directly from
 * Flutterwave's own documentation and SDK examples, not guessed.
 *
 * Auth: SUPER_ADMIN only.
 */
'use strict';

const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ['SUPER_ADMIN'])) return err(403, 'SUPER_ADMIN required for subscription plan setup');

  const secretKey = (process.env.FLW_V3_SECRET_KEY || '').trim();
  if (!secretKey) return err(500, 'FLW_V3_SECRET_KEY not configured');

  const db = getServiceClient();

  const { data: catalog } = await db.from('coop_subscription_plan_catalog').select('*');
  const results = [];

  for (const plan of (catalog || [])) {
    if (plan.flutterwave_plan_id) {
      results.push({ tier: plan.tier, cycle: plan.cycle, status: 'already_exists', flutterwave_plan_id: plan.flutterwave_plan_id });
      continue;
    }

    try {
      const res = await fetch('https://api.flutterwave.com/v3/payment-plans', {
        method: 'POST',
        headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: plan.amount_kobo / 100,
          name: `Zillion Coop — ${plan.tier.charAt(0).toUpperCase() + plan.tier.slice(1)} (${plan.cycle})`,
          interval: plan.cycle, // 'monthly' | 'yearly'
        }),
      });
      const data = await res.json();
      if (data.status !== 'success' || !data.data?.id) {
        results.push({ tier: plan.tier, cycle: plan.cycle, status: 'failed', error: data.message || 'unknown error' });
        continue;
      }

      await db.from('coop_subscription_plan_catalog')
        .update({ flutterwave_plan_id: String(data.data.id) })
        .eq('id', plan.id);

      results.push({ tier: plan.tier, cycle: plan.cycle, status: 'created', flutterwave_plan_id: data.data.id });
    } catch (e) {
      results.push({ tier: plan.tier, cycle: plan.cycle, status: 'failed', error: e.message });
    }
  }

  return ok({ success: true, results });
};
