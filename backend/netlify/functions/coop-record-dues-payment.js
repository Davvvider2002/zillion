/**
 * zillion/backend/netlify/functions/coop-record-dues-payment.js
 *
 * POST /api/v1/coop-record-dues-payment
 *
 * Admin records a member's dues payment — same interim-bridge pattern
 * as coop-record-savings-payment.js, and the same cash-payment honesty
 * rule (a reference is required for cash_in_person, since it has no
 * independent bank record to check against).
 *
 * Unlike savings, dues isn't tied to a specific plan — it's a
 * recurring, per-member obligation the society sets once for everyone.
 * So this takes a member_id directly, not a plan id.
 *
 * Auth: SUPER_ADMIN or OPERATIONS.
 * Body: { member_id, amount_kobo, reference?, source? }
 */
'use strict';

const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { auditLog }               = require('../../lib/auditLog');
const { recordDuesPaymentJournalEntry } = require('../../lib/coopDuesAccounting');

const VALID_SOURCES = ['bank_transfer_manual', 'cash_in_person'];

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ['SUPER_ADMIN', 'OPERATIONS']))
    return err(403, 'SUPER_ADMIN or OPERATIONS role required to record dues payments');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const memberId    = (body.member_id || '').trim();
  const amountKobo  = Number.isInteger(body.amount_kobo) ? body.amount_kobo : 0;
  const reference    = (body.reference || '').trim() || null;
  const source        = VALID_SOURCES.includes(body.source) ? body.source : 'bank_transfer_manual';

  if (!memberId)       return err(400, 'member_id is required');
  if (amountKobo <= 0) return err(400, 'amount_kobo must be a positive integer');
  if (source === 'cash_in_person' && !reference)
    return err(400, 'A reference (receipt number, witness name, etc.) is required when recording a cash payment.');

  const db = getServiceClient();

  const { data: member } = await db.from('coop_members').select('id, coop_id, status').eq('id', memberId).maybeSingle();
  if (!member) return err(404, 'Member not found');
  if (member.status !== 'ACTIVE') return err(409, `This member's status is ${member.status}, not ACTIVE`);

  const { data: created, error: insertErr } = await db.from('coop_dues_transactions').insert({
    coop_id:       member.coop_id,
    member_id:      memberId,
    amount_kobo:     amountKobo,
    source,
    reference,
    recorded_by:       auth.payload.username || auth.payload.sub,
  }).select().single();

  if (insertErr) return err(500, `Failed to record dues payment: ${insertErr.message}`);

  await recordDuesPaymentJournalEntry(db, member.coop_id, amountKobo, source, auth.payload.username || auth.payload.sub);

  await auditLog(db, {
    action:       'COOP_DUES_PAYMENT_RECORDED',
    username:     auth.payload.username || auth.payload.sub,
    role:         auth.payload.role,
    ip:           event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_dues_transaction',
    resourceId:   created.id,
    requestBody:  body,
    result:       'SUCCESS',
  });

  return ok({ success: true, transaction: created });
};
