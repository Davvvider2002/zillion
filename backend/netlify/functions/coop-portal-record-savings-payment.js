/**
 * zillion/backend/netlify/functions/coop-portal-record-savings-payment.js
 *
 * POST /api/v1/coop-portal-record-savings-payment
 *
 * Society-admin self-service version of coop-record-savings-payment.js.
 * Same recording logic, but with an extra check the admin version
 * doesn't need: the savings plan must actually belong to the caller's
 * own resolved society — a plan ID alone isn't enough authorization,
 * since nothing stops a malicious caller from guessing or enumerating
 * another society's plan IDs.
 *
 * Body: { savings_plan_id, amount_kobo, reference?, source? }
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety } = require('../../lib/coopPortalAuth');
const { auditLog }             = require('../../lib/auditLog');

const VALID_SOURCES = ['bank_transfer_manual', 'cash_in_person'];

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');

  const db = getServiceClient();
  const resolved = await resolvePortalSociety(db, auth);
  if (!resolved.ok) return err(resolved.status, resolved.error);
  const coopId = resolved.society.coop_id;

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const savingsPlanId = (body.savings_plan_id || '').trim();
  const amountKobo    = Number.isInteger(body.amount_kobo) ? body.amount_kobo : 0;
  const reference      = (body.reference || '').trim() || null;
  const source          = VALID_SOURCES.includes(body.source) ? body.source : 'bank_transfer_manual';

  if (!savingsPlanId)  return err(400, 'savings_plan_id is required');
  if (amountKobo <= 0) return err(400, 'amount_kobo must be a positive integer');
  if (source === 'cash_in_person' && !reference)
    return err(400, 'A reference (receipt number, member name, etc.) is required when recording a cash payment.');

  const { data: plan } = await db.from('coop_savings_plans')
    .select('id, coop_id, member_id, status').eq('id', savingsPlanId).maybeSingle();
  if (!plan) return err(404, 'Savings plan not found');
  if (plan.coop_id !== coopId) return err(403, 'This savings plan does not belong to your society.');
  if (plan.status !== 'ACTIVE') return err(409, `This savings plan is ${plan.status}, not ACTIVE`);

  const { data: created, error: insertErr } = await db.from('coop_savings_transactions').insert({
    coop_id:          coopId,
    member_id:         plan.member_id,
    savings_plan_id:    savingsPlanId,
    amount_kobo:         amountKobo,
    source,
    reference,
    recorded_by:           `portal:${auth.payload.merchant_id}`,
  }).select().single();

  if (insertErr) return err(500, `Failed to record payment: ${insertErr.message}`);

  await auditLog(db, {
    action:       'COOP_PORTAL_SAVINGS_PAYMENT_RECORDED',
    username:     auth.payload.merchant_id,
    role:         'merchant',
    ip:           event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_savings_transaction',
    resourceId:   created.id,
    requestBody:  body,
    result:       'SUCCESS',
  });

  return ok({ success: true, transaction: created });
};
