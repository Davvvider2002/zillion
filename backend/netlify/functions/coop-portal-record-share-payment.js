/**
 * zillion/backend/netlify/functions/coop-portal-record-share-payment.js
 *
 * POST /api/v1/coop-portal-record-share-payment
 *
 * Society-admin records a share capital contribution for a member -
 * same pattern as coop-portal-record-savings-payment.js. Posts to the
 * accounting ledger when Accounting is set up: Debit Cash or Bank,
 * Credit the existing Share Capital equity account (code 3000, which
 * already existed in the default chart of accounts before this
 * feature had any transaction-level tracking behind it).
 *
 * Body: { member_id, amount_kobo, reference?, source? }
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety } = require('../../lib/coopPortalAuth');
const { auditLog }             = require('../../lib/auditLog');
const { accountingIsReady, getAccounts, postEntry } = require('../../lib/coopAccountingHelpers');

const VALID_SOURCES = ['bank_transfer_manual', 'cash_in_person'];
const CASH_ACCOUNT_CODE = '1000';
const BANK_ACCOUNT_CODE = '1010';
const SHARE_CAPITAL_ACCOUNT_CODE = '3000';

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

  const memberId    = (body.member_id || '').trim();
  const amountKobo  = Number.isInteger(body.amount_kobo) ? body.amount_kobo : 0;
  const reference    = (body.reference || '').trim() || null;
  const source        = VALID_SOURCES.includes(body.source) ? body.source : 'bank_transfer_manual';

  if (!memberId)       return err(400, 'member_id is required');
  if (amountKobo <= 0) return err(400, 'amount_kobo must be a positive integer');
  if (source === 'cash_in_person' && !reference)
    return err(400, 'A reference (receipt number, member name, etc.) is required when recording a cash payment.');

  const { data: member } = await db.from('coop_members').select('id, coop_id, status').eq('id', memberId).maybeSingle();
  if (!member) return err(404, 'Member not found');
  if (member.coop_id !== coopId) return err(403, 'This member does not belong to your society.');
  if (member.status !== 'ACTIVE') return err(409, `This member's status is ${member.status}, not ACTIVE`);

  const { data: created, error: insertErr } = await db.from('coop_share_transactions').insert({
    coop_id:      coopId,
    member_id:    memberId,
    amount_kobo:  amountKobo,
    source,
    reference,
    recorded_by:  `portal:${auth.payload.merchant_id}`,
  }).select().single();

  if (insertErr) return err(500, `Failed to record share contribution: ${insertErr.message}`);

  try {
    if (await accountingIsReady(db, coopId)) {
      const debitCode = source === 'cash_in_person' ? CASH_ACCOUNT_CODE : BANK_ACCOUNT_CODE;
      const accounts = await getAccounts(db, coopId, [debitCode, SHARE_CAPITAL_ACCOUNT_CODE]);
      const debitAccount = accounts[debitCode];
      const shareCapital = accounts[SHARE_CAPITAL_ACCOUNT_CODE];
      if (debitAccount && shareCapital) {
        await postEntry(db, coopId, 'Share capital contribution', `portal:${auth.payload.merchant_id}`, debitAccount, shareCapital, amountKobo);
      }
    }
  } catch (e) {
    console.error('[coop-portal-record-share-payment] accounting post failed (non-fatal):', e.message);
  }

  await auditLog(db, {
    action:       'COOP_PORTAL_SHARE_PAYMENT_RECORDED',
    username:     auth.payload.merchant_id,
    role:         'merchant',
    ip:           event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_share_transaction',
    resourceId:   created.id,
    requestBody:  body,
    result:       'SUCCESS',
  });

  return ok({ success: true, transaction: created });
};
