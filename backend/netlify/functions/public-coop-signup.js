/**
 * zillion/backend/netlify/functions/public-coop-signup.js
 *
 * POST /api/v1/public-coop-signup
 *
 * Public self-service signup — no authentication, reachable from the
 * landing page. Creates a real merchant identity + coop_societies row
 * with a real, immediately-usable 30-day free trial — no payment
 * collected at signup. Flutterwave has no mechanism to collect a card
 * now and delay the first charge, so a genuine trial has to mean
 * "usable now, pay before it ends" rather than "card on file,
 * charged later." subscription_status starts as 'trial'; the
 * society's operational status is 'TRIAL' too (same field
 * admin-created societies use), so they can actually log in and use
 * the product during the trial, not just be registered.
 *
 * Body: { society_name, phone, owner_name, email, password, location?, plan, cycle }
 */
'use strict';

const { createHmac } = require('crypto');
const { getServiceClient } = require('../../lib/supabase');
const { resolveOrCreateZillionId } = require('../../lib/zillionId');

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error('Server misconfigured: ' + name + ' is not set');
  return v;
}

function normalisePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('234')) return '+' + digits;
  if (digits.startsWith('0'))   return '+234' + digits.slice(1);
  return '+' + digits;
}

const VALID_PLANS = ['launch', 'growth', 'scale'];
const VALID_CYCLES = ['monthly', 'yearly'];

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const name         = (body.society_name || '').trim();
  const rawPhone       = (body.phone || '').trim();
  const ownerName        = (body.owner_name || '').trim();
  const email               = (body.email || '').trim().toLowerCase();
  const password              = (body.password || '').trim();
  const location                = (body.location || '').trim();
  const plan                       = VALID_PLANS.includes(body.plan) ? body.plan : null;
  const cycle                         = VALID_CYCLES.includes(body.cycle) ? body.cycle : null;

  if (!name)      return err(400, 'society_name is required');
  if (!rawPhone)   return err(400, 'phone is required');
  if (!ownerName)   return err(400, 'owner_name is required');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err(400, 'A valid email is required — recurring billing is tied to this address');
  if (!password || password.length < 6) return err(400, 'password must be at least 6 characters');
  if (!plan)  return err(400, 'plan must be one of: launch, growth, scale');
  if (!cycle)  return err(400, 'cycle must be one of: monthly, yearly');

  const phone = normalisePhone(rawPhone);
  if (!/^\+\d{10,15}$/.test(phone)) return err(400, `Invalid phone number: "${phone}"`);

  const db = getServiceClient();
  const merchantId = 'MERCH-' + phone.replace(/\D/g, '').slice(-8);

  const { data: existingMerchant } = await db.from('merchants').select('merchant_id').eq('merchant_id', merchantId).maybeSingle();
  if (existingMerchant) return err(409, `An account already exists for this phone number. Contact support if this is unexpected.`);

  const { data: planRow } = await db.from('coop_subscription_plan_catalog').select('*').eq('tier', plan).eq('cycle', cycle).maybeSingle();
  if (!planRow) return err(500, `Plan configuration missing for ${plan}/${cycle} — contact support`);
  if (!planRow.flutterwave_plan_id) return err(500, 'Subscription billing is not fully configured yet — contact support');

  let zillionId = null;
  try { zillionId = await resolveOrCreateZillionId(db, phone, 'merchant'); }
  catch (e) { console.warn('[public-coop-signup] zillion identity link failed (non-fatal):', e.message); }

  const passwordHash = createHmac('sha256', mustEnv('JWT_SECRET')).update(password).digest('hex');
  const now = new Date().toISOString();

  const { error: merchantErr } = await db.from('merchants').insert({
    merchant_id:    merchantId,
    phone,
    password_hash:    passwordHash,
    owner_name:         ownerName,
    business_name:        name,
    business_type:          'Cooperative',
    location,
    status:                    'ACTIVE',
    registered_at:               now,
    last_login:                     now,
    zil_balance_kobo:                 0,
    zillion_id:                         zillionId,
  });
  if (merchantErr) return err(500, `Failed to create account: ${merchantErr.message}`);

  const { data: society, error: societyErr } = await db.from('coop_societies').insert({
    merchant_id:              merchantId,
    name,
    phone,
    owner_name:                  ownerName,
    subscription_status:            'trial',
    subscription_plan:                 plan,
    subscription_cycle:                   cycle,
    subscription_email:                      email,
    flutterwave_payment_plan_id:                planRow.flutterwave_plan_id,
    signup_source:                                 'self_service',
    status:                                           'TRIAL', // usable immediately, matching how admin-created trial societies already work
    trial_ends_at:                                       new Date(Date.now() + 30*24*60*60*1000).toISOString(),
  }).select().single();

  if (societyErr) {
    await db.from('merchants').delete().eq('merchant_id', merchantId);
    return err(500, `Failed to register society: ${societyErr.message}`);
  }

  return ok({
    success: true,
    coop_id: society.coop_id,
    trial_ends_at: society.trial_ends_at,
    message: `${name} is registered and ready to use — your 30-day free trial has started.`,
  });
};
