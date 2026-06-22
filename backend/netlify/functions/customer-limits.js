/**
 * GET /api/v1/customer/limits
 * Sprint 2: Returns current KYC tier, daily limit and remaining allowance.
 * Called by wallet on login and before each send to enforce CBN limits.
 *
 * Auth: OTP JWT
 */
'use strict';

const { createClient } = require('@supabase/supabase-js');
const { verifyJWT }    = require('../../lib/validators');

const TIER_LIMITS = {
  1: parseInt(process.env.TIER1_DAILY_LIMIT_KOBO || '5000000'),   // ₦50,000
  2: parseInt(process.env.TIER2_DAILY_LIMIT_KOBO || '20000000'),  // ₦200,000
  3: Number.MAX_SAFE_INTEGER,                                       // unlimited
};

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b    => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m)=> ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(
    event.headers.authorization || event.headers.Authorization || ''
  );
  if (!auth.valid) return err(401, auth.reason);

  const deviceId = auth.payload.sub;
  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );

  // Get device KYC tier
  const { data: device } = await db
    .from('devices')
    .select('kyc_tier, daily_limit_kobo')
    .eq('device_hash', deviceId)
    .single();

  const tier      = device?.kyc_tier        || 1;
  const limitKobo = device?.daily_limit_kobo || TIER_LIMITS[tier] || TIER_LIMITS[1];

  // Get today's settled transaction total for this device
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { data: txns } = await db
    .from('transactions')
    .select('amount')
    .eq('from_hash', deviceId)
    .gte('sync_ts', todayStart.toISOString())
    .eq('status', 'SETTLED');

  const usedKobo      = (txns || []).reduce((s, t) => s + (t.amount || 0), 0);
  const remainingKobo = Math.max(0, limitKobo - usedKobo);

  const fmt = k => k === Number.MAX_SAFE_INTEGER ? 'unlimited'
    : `₦${(k / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;

  return ok({
    device_id:           deviceId,
    tier,
    tier_name:           `Tier ${tier}`,
    daily_limit_kobo:    limitKobo,
    daily_limit_display: fmt(limitKobo),
    used_today_kobo:     usedKobo,
    used_today_display:  fmt(usedKobo),
    remaining_kobo:      remainingKobo,
    remaining_display:   fmt(remainingKobo),
    can_transact:        remainingKobo > 0,
    reset_at:            new Date(todayStart.getTime() + 86400000).toISOString(),
    upgrade_available:   tier < 3,
    next_tier_action:    tier === 1 ? 'Verify NIN to upgrade to Tier 2 (₦200,000/day)'
                       : tier === 2 ? 'Verify BVN + address to upgrade to Tier 3 (unlimited)'
                       : 'Maximum tier reached',
  });
};
