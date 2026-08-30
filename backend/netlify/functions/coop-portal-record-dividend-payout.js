/**
 * zillion/backend/netlify/functions/coop-portal-record-dividend-payout.js
 *
 * POST /api/v1/coop-portal-record-dividend-payout
 * GET  /api/v1/coop-portal-record-dividend-payout?entitlement_id=X
 *
 * Records how a member's APPROVED dividend entitlement was actually
 * paid out - cash, credited to savings, converted to shares, or a
 * split across any combination. Each call adds payout records
 * (supports paying out in stages); the cumulative total across all
 * payouts for one entitlement can never exceed the entitlement itself.
 *
 * Same pattern as loan disbursement: for 'cash', this records that
 * the admin already sent the money through the society's own banking
 * arrangements - the platform doesn't move money itself, it doesn't
 * call any bank transfer API. For 'savings' and 'shares', the credit
 * is genuinely internal and automated: a real coop_savings_transactions
 * or coop_share_transactions row is created immediately, so the
 * member's actual balance reflects it, not just a payout record that
 * says it should.
 *
 * Accounting (when Accounting is set up): every method debits
 * Dividend Payable (settling the liability booked at approval) and
 * credits Bank (cash), Member Savings Payable (savings), or Share
 * Capital (shares).
 *
 * Body: { entitlement_id, payouts: [{ method, amount_kobo, reference? }] }
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety } = require('../../lib/coopPortalAuth');
const { auditLog }             = require('../../lib/auditLog');
const { accountingIsReady, getAccounts, postEntry } = require('../../lib/coopAccountingHelpers');

const VALID_METHODS = ['cash', 'savings', 'shares'];
const BANK_ACCOUNT_CODE = '1010';
const MEMBER_SAVINGS_PAYABLE_ACCOUNT_CODE = '2000';
const SHARE_CAPITAL_ACCOUNT_CODE = '3000';
const DIVIDEND_PAYABLE_ACCOUNT_CODE = '2200';

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');

  const db = getServiceClient();
  const resolved = await resolvePortalSociety(db, auth);
  if (!resolved.ok) return err(resolved.status, resolved.error);
  const coopId = resolved.society.coop_id;

  if (event.httpMethod === 'GET') {
    const entitlementId = event.queryStringParameters?.entitlement_id;
    if (!entitlementId) return err(400, 'entitlement_id is required');
    const { data: payouts } = await db.from('coop_dividend_payouts')
      .select('*').eq('entitlement_id', entitlementId).eq('coop_id', coopId).order('recorded_at');
    return ok({ payouts: payouts || [] });
  }

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const entitlementId = (body.entitlement_id || '').trim();
  if (!entitlementId) return err(400, 'entitlement_id is required');

  const { data: entitlement } = await db.from('coop_dividend_entitlements')
    .select('*, coop_dividend_runs!inner(status, coop_id), coop_members(name)')
    .eq('id', entitlementId).eq('coop_id', coopId).maybeSingle();
  if (!entitlement) return err(404, 'Entitlement not found in your society');
  if (entitlement.coop_dividend_runs.status !== 'approved')
    return err(400, 'This dividend run is not approved yet — nothing can be paid out until it is.');

  const payouts = Array.isArray(body.payouts) ? body.payouts : [];
  if (!payouts.length) return err(400, 'payouts must be a non-empty array');

  let newTotal = 0;
  const cleanPayouts = [];
  for (const p of payouts) {
    if (!VALID_METHODS.includes(p.method)) return err(400, `Invalid method "${p.method}" — must be one of: ${VALID_METHODS.join(', ')}`);
    const amountKobo = Number(p.amount_kobo);
    if (!Number.isFinite(amountKobo) || amountKobo <= 0) return err(400, `Invalid amount for ${p.method}`);
    if (p.method === 'cash' && !(p.reference || '').trim())
      return err(400, 'A reference is required for a cash payout, confirming it was actually sent.');
    newTotal += amountKobo;
    cleanPayouts.push({ method: p.method, amount_kobo: amountKobo, reference: (p.reference || '').trim() || null });
  }

  const { data: existingPayouts } = await db.from('coop_dividend_payouts').select('amount_kobo').eq('entitlement_id', entitlementId);
  const alreadyPaidKobo = (existingPayouts || []).reduce((s, p) => s + p.amount_kobo, 0);
  if (alreadyPaidKobo + newTotal > entitlement.entitlement_kobo) {
    return err(400, `This would pay out ${((alreadyPaidKobo + newTotal) / 100).toLocaleString()} total, exceeding the ${(entitlement.entitlement_kobo / 100).toLocaleString()} entitlement (${(alreadyPaidKobo / 100).toLocaleString()} already recorded).`);
  }

  const createdRows = [];
  const accountingReady = await accountingIsReady(db, coopId);
  const payableAccounts = accountingReady ? await getAccounts(db, coopId, [DIVIDEND_PAYABLE_ACCOUNT_CODE, BANK_ACCOUNT_CODE, MEMBER_SAVINGS_PAYABLE_ACCOUNT_CODE, SHARE_CAPITAL_ACCOUNT_CODE]) : {};

  for (const p of cleanPayouts) {
    const { data: created, error: insertErr } = await db.from('coop_dividend_payouts').insert({
      entitlement_id: entitlementId, coop_id: coopId, member_id: entitlement.member_id,
      method: p.method, amount_kobo: p.amount_kobo, status: 'completed',
      reference: p.reference, recorded_by: `portal:${auth.payload.merchant_id}`, completed_at: new Date().toISOString(),
    }).select().single();
    if (insertErr) return err(500, `Failed to record payout: ${insertErr.message}`);
    createdRows.push(created);

    if (p.method === 'savings') {
      await db.from('coop_savings_transactions').insert({
        coop_id: coopId, member_id: entitlement.member_id, amount_kobo: p.amount_kobo,
        source: 'dividend_credit', reference: `Dividend payout ${created.id}`, recorded_by: `portal:${auth.payload.merchant_id}`,
      });
    } else if (p.method === 'shares') {
      await db.from('coop_share_transactions').insert({
        coop_id: coopId, member_id: entitlement.member_id, amount_kobo: p.amount_kobo,
        source: 'dividend_credit', reference: `Dividend payout ${created.id}`, recorded_by: `portal:${auth.payload.merchant_id}`,
      });
    }

    try {
      if (accountingReady) {
        const payable = payableAccounts[DIVIDEND_PAYABLE_ACCOUNT_CODE];
        const creditCode = p.method === 'cash' ? BANK_ACCOUNT_CODE : (p.method === 'savings' ? MEMBER_SAVINGS_PAYABLE_ACCOUNT_CODE : SHARE_CAPITAL_ACCOUNT_CODE);
        const creditAccount = payableAccounts[creditCode];
        if (payable && creditAccount) {
          await postEntry(db, coopId, `Dividend paid — ${entitlement.coop_members?.name || 'member'} (${p.method})`, `portal:${auth.payload.merchant_id}`, payable, creditAccount, p.amount_kobo);
        }
      }
    } catch (e) {
      console.error('[coop-portal-record-dividend-payout] accounting post failed (non-fatal):', e.message);
    }
  }

  await auditLog(db, {
    action:       'COOP_PORTAL_DIVIDEND_PAYOUT_RECORDED',
    username:     auth.payload.merchant_id,
    role:         'merchant',
    ip:           event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_dividend_entitlement',
    resourceId:   entitlementId,
    requestBody:  body,
    result:       'SUCCESS',
  });

  return ok({ success: true, payouts: createdRows, total_paid_kobo: alreadyPaidKobo + newTotal, remaining_kobo: entitlement.entitlement_kobo - (alreadyPaidKobo + newTotal) });
};
