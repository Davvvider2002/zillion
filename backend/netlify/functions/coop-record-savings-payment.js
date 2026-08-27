/**
 * zillion/backend/netlify/functions/coop-record-savings-payment.js
 *
 * POST /api/v1/coop-record-savings-payment
 *
 * Admin manually confirms a member's bank transfer landed and records
 * it against their savings plan. This is the interim bridge before the
 * Moniepoint/OPay webhook integration is live — same "admin sees proof,
 * confirms, credits" step as the original manual process, just without
 * the screenshot-upload UI. Once the webhook is live, it writes to this
 * exact same table automatically (source='webhook_moniepoint' etc.) —
 * this endpoint doesn't change or get removed, it just becomes one of
 * two ways a row can land here.
 *
 * Auth: SUPER_ADMIN or OPERATIONS.
 * Body: { savings_plan_id, amount_kobo, reference?, source? }
 *   source: "bank_transfer_manual" (default) | "cash_in_person"
 *   For cash_in_person, reference is REQUIRED — cash has no independent
 *   bank record behind it the way a manually-confirmed transfer does,
 *   so a receipt number or witness note is the minimum honest audit
 *   trail. This doesn't eliminate the trust dependency on the admin
 *   recording it accurately, but it makes the audit trail honest about
 *   where that dependency exists.
 */
'use strict';

const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { auditLog }               = require('../../lib/auditLog');

const VALID_SOURCES = ['bank_transfer_manual', 'cash_in_person'];

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ['SUPER_ADMIN', 'OPERATIONS']))
    return err(403, 'SUPER_ADMIN or OPERATIONS role required to record savings payments');

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
    return err(400, 'A reference (receipt number, witness name, etc.) is required when recording a cash payment — cash has no independent bank record behind it.');

  const db = getServiceClient();

  const { data: plan } = await db.from('coop_savings_plans')
    .select('id, coop_id, member_id, status').eq('id', savingsPlanId).maybeSingle();
  if (!plan) return err(404, 'Savings plan not found');
  if (plan.status !== 'ACTIVE') return err(409, `This savings plan is ${plan.status}, not ACTIVE`);

  const { data: created, error: insertErr } = await db.from('coop_savings_transactions').insert({
    coop_id:          plan.coop_id,
    member_id:         plan.member_id,
    savings_plan_id:    savingsPlanId,
    amount_kobo:         amountKobo,
    source,
    reference,
    recorded_by:           auth.payload.username || auth.payload.sub,
  }).select().single();

  if (insertErr) return err(500, `Failed to record payment: ${insertErr.message}`);

  await auditLog(db, {
    action:       'COOP_SAVINGS_PAYMENT_RECORDED',
    username:     auth.payload.username || auth.payload.sub,
    role:         auth.payload.role,
    ip:           event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_savings_transaction',
    resourceId:   created.id,
    requestBody:  body,
    result:       'SUCCESS',
  });

  return ok({ success: true, transaction: created });
};
