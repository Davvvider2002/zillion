/**
 * GET /api/v1/bank/customer/:phone
 * Sprint 3: Customer lookup for bank CRM integration.
 * Auth: Bank API key
 */
'use strict';

const { createClient } = require('@supabase/supabase-js');
const { createHmac }   = require('crypto');
const { verifyBankAuth } = require('../../lib/bank-auth');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b    => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m)=> ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyBankAuth(event);
  if (!auth.valid) return err(401, auth.reason);

  const phone = decodeURIComponent(event.path?.split('/').pop() || '') ||
                event.queryStringParameters?.phone;
  if (!phone) return err(400, 'Missing phone in path or query');

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );

  // Hash phone the same way OTP and activation do
  const phoneHash = createHmac('sha256', process.env.SUPABASE_SERVICE_KEY || 'salt')
    .update(phone).digest('hex');

  const { data: device, error } = await db.from('devices')
    .select('device_hash, kyc_tier, daily_limit_kobo, last_sync, registered_at, status')
    .eq('phone_hash', phoneHash).limit(1);

  if (error || !device || device.length === 0)
    return err(404, `Customer not found for phone: ${phone}`);

  const d = device[0];

  // Get balance from held coins
  const { data: coins } = await db.from('coins')
    .select('amount').eq('holder_hash', d.device_hash).eq('status', 'HELD');

  const balanceKobo = (coins || []).reduce((s, c) => s + (c.amount || 0), 0);

  // Get settled transaction count
  const { count: txCount } = await db.from('transactions')
    .select('*', { count: 'exact', head: true })
    .or(`from_hash.eq.${d.device_hash},to_hash.eq.${d.device_hash}`)
    .eq('status', 'SETTLED');

  return ok({
    customer_id:       d.device_hash.slice(0, 16).toUpperCase(),
    status:            d.status,
    tier:              d.kyc_tier || 1,
    daily_limit_kobo:  d.daily_limit_kobo || 5000000,
    balance_kobo:      balanceKobo,
    balance_naira:     balanceKobo / 100,
    transaction_count: txCount || 0,
    last_active:       d.last_sync,
    member_since:      d.registered_at,
    queried_at:        new Date().toISOString(),
  });
};
