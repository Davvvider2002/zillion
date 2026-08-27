/**
 * zillion/backend/netlify/functions/admin-create-coop-subaccount.js
 *
 * POST /api/v1/admin-create-coop-subaccount
 *
 * Creates a Flutterwave Subaccount for a cooperative society, linking
 * their own real bank account. Once set, every checkout for this
 * society's savings/dues/loan-repayment automatically splits: the
 * society's subaccount receives exactly the base amount (flat split),
 * everything else (Flutterwave's fee + Zillion's matching fee) stays
 * with Zillion's main settlement account.
 *
 * Uses v3 (Subaccounts are a v3 feature, same auth as hosted
 * checkout) — confirmed against Flutterwave's own Subaccounts
 * documentation before building this, not guessed.
 *
 * Auth: SUPER_ADMIN or OPERATIONS.
 * Body: { coop_id, account_bank_code, account_number, business_name? }
 */
'use strict';

const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { auditLog }               = require('../../lib/auditLog');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ['SUPER_ADMIN', 'OPERATIONS']))
    return err(403, 'SUPER_ADMIN or OPERATIONS role required to configure settlement');

  const secretKey = (process.env.FLW_V3_SECRET_KEY || '').trim();
  if (!secretKey) return err(500, 'FLW_V3_SECRET_KEY not configured');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const coopId          = (body.coop_id || '').trim();
  const accountBankCode  = (body.account_bank_code || '').trim();
  const accountNumber     = (body.account_number || '').trim();
  const businessName        = (body.business_name || '').trim();
  const businessEmail         = (body.business_email || '').trim();

  if (!coopId)           return err(400, 'coop_id is required');
  if (!accountBankCode)   return err(400, 'account_bank_code is required (Flutterwave bank code, e.g. "044" for Access Bank)');
  if (!accountNumber)      return err(400, 'account_number is required');
  if (!businessEmail)       return err(400, 'business_email is required — Flutterwave uses this for settlement and compliance communications with the society');

  const db = getServiceClient();

  const { data: society } = await db.from('coop_societies').select('coop_id, name, flutterwave_subaccount_id').eq('coop_id', coopId).maybeSingle();
  if (!society) return err(404, 'Cooperative society not found');
  if (society.flutterwave_subaccount_id) return err(409, 'This society already has a settlement account configured');

  let flwResponse;
  try {
    const res = await fetch('https://api.flutterwave.com/v3/subaccounts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_bank:    accountBankCode,
        account_number:   accountNumber,
        business_name:     businessName || society.name,
        business_email:      businessEmail,
        business_mobile:       '00000000000', // required field; not otherwise used for split settlement itself
        country:               'NG',
        split_type:               'flat',
        split_value:                 0, // 0 here — the actual split amount is specified per-transaction at checkout time (base amount varies every time), not fixed at subaccount creation
      }),
    });
    flwResponse = await res.json();
    if (flwResponse.status !== 'success' || !flwResponse.data?.subaccount_id) {
      return err(502, `Flutterwave rejected the subaccount request: ${flwResponse.message || 'unknown error'}`);
    }
  } catch (e) {
    return err(502, `Failed to reach Flutterwave: ${e.message}`);
  }

  const { data: updated, error: updateErr } = await db.from('coop_societies')
    .update({
      flutterwave_subaccount_id:      flwResponse.data.subaccount_id,
      settlement_bank_code:             accountBankCode,
      settlement_account_number:          accountNumber,
      settlement_account_name:              flwResponse.data.full_name || businessName || society.name,
    })
    .eq('coop_id', coopId)
    .select().single();

  if (updateErr) return err(500, `Subaccount created with Flutterwave but failed to save locally: ${updateErr.message}. subaccount_id was ${flwResponse.data.subaccount_id} — contact support before retrying.`);

  await auditLog(db, {
    action:       'COOP_SUBACCOUNT_CREATED',
    username:     auth.payload.username || auth.payload.sub,
    role:         auth.payload.role,
    ip:           event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_society',
    resourceId:   coopId,
    requestBody:  body,
    result:       'SUCCESS',
  });

  return ok({
    success: true,
    society: updated,
    message: `Settlement configured for ${society.name}. Their payments will now split automatically to ${flwResponse.data.full_name || accountNumber}.`,
  });
};
