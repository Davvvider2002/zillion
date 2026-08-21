/**
 * zillion/backend/netlify/functions/admin-create-coop-society.js
 *
 * POST /api/v1/admin-create-coop-society
 *
 * Creates a new cooperative society — the one thing that's been
 * genuinely missing this whole module: every test society so far was
 * inserted directly via SQL, not through any real endpoint.
 *
 * A society's payment identity IS a Merchant record (established
 * architecture decision from early planning) — this creates both
 * together: a new merchant (for in-person payment collection via the
 * existing Merchant app) and the coop_societies row linking to it.
 *
 * 30-day trial starts immediately (matches the agreed subscription
 * design — billing/enforcement logic for after the trial ends is
 * still a separate, not-yet-built piece; this just starts the clock).
 *
 * Auth: SUPER_ADMIN or OPERATIONS.
 * Body: { name, phone, owner_name, location, password, lascofed_ref?,
 *         opening_loan_capital_kobo?, opening_bank_balance_kobo? }
 */
'use strict';

const { createHmac } = require('crypto');
const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { resolveOrCreateZillionId } = require('../../lib/zillionId');
const { auditLog }               = require('../../lib/auditLog');

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

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ['SUPER_ADMIN', 'OPERATIONS']))
    return err(403, 'SUPER_ADMIN or OPERATIONS role required to create a cooperative society');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const name         = (body.name || '').trim();
  const rawPhone       = (body.phone || '').trim();
  const ownerName        = (body.owner_name || '').trim();
  const location           = (body.location || '').trim();
  const password             = (body.password || '').trim();
  const lascofedRef            = (body.lascofed_ref || '').trim() || null;
  const openingLoanCapital       = Number.isInteger(body.opening_loan_capital_kobo) ? body.opening_loan_capital_kobo : 0;
  const openingBankBalance         = Number.isInteger(body.opening_bank_balance_kobo) ? body.opening_bank_balance_kobo : 0;

  if (!name)      return err(400, 'name is required');
  if (!rawPhone)   return err(400, 'phone is required');
  if (!ownerName)   return err(400, 'owner_name is required');
  if (!password || password.length < 6) return err(400, 'password must be at least 6 characters');

  const phone = normalisePhone(rawPhone);
  if (!/^\+\d{10,15}$/.test(phone)) return err(400, `Invalid phone number: "${phone}"`);

  const db = getServiceClient();
  const merchantId = 'MERCH-' + phone.replace(/\D/g, '').slice(-8);

  const { data: existingMerchant } = await db.from('merchants').select('merchant_id').eq('merchant_id', merchantId).maybeSingle();
  if (existingMerchant) return err(409, `A merchant already exists for this phone number (${merchantId}) — choose a different number or use the existing account.`);

  let zillionId = null;
  try { zillionId = await resolveOrCreateZillionId(db, phone, 'merchant'); }
  catch (e) { console.warn('[admin-create-coop-society] zillion identity link failed (non-fatal):', e.message); }

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
  if (merchantErr) return err(500, `Failed to create the society's merchant identity: ${merchantErr.message}`);

  const trialEndsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: society, error: societyErr } = await db.from('coop_societies').insert({
    merchant_id:                merchantId,
    name,
    phone,
    owner_name:                    ownerName,
    lascofed_ref:                     lascofedRef,
    status:                             'TRIAL',
    trial_ends_at:                        trialEndsAt,
    opening_loan_capital_kobo:               openingLoanCapital,
    opening_bank_balance_kobo:                  openingBankBalance,
  }).select().single();

  if (societyErr) {
    // Clean up the merchant we just created rather than leave an
    // orphaned, non-functional merchant record with no society behind it.
    await db.from('merchants').delete().eq('merchant_id', merchantId);
    return err(500, `Failed to create the society record: ${societyErr.message}`);
  }

  await auditLog(db, {
    action:       'COOP_SOCIETY_CREATED',
    username:     auth.payload.username || auth.payload.sub,
    role:         auth.payload.role,
    ip:           event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_society',
    resourceId:   society.coop_id,
    requestBody:  { ...body, password: '[redacted]' },
    result:       'SUCCESS',
  });

  return ok({
    success: true,
    society,
    merchant_id: merchantId,
    message: `${name} created — trial ends ${new Date(trialEndsAt).toLocaleDateString()}. The society can log into the Merchant app with ${phone} for in-person payment collection.`,
  });
};
