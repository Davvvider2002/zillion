/**
 * zillion/backend/netlify/functions/coop-provision-flutterwave-account.js
 *
 * POST /api/v1/coop-provision-flutterwave-account
 *
 * Admin-triggered: creates a static Flutterwave virtual account for a
 * member's savings plan. Once provisioned, the member pays their
 * monthly saving by transferring to this account from any Nigerian
 * bank — the webhook (coop-flutterwave-webhook.js) then credits it
 * automatically.
 *
 * REBUILT from an earlier version that used v3's directly-passed
 * secret key — confirmed directly by Flutterwave's own support that
 * both sandbox AND production actually require OAuth 2.0
 * client_credentials (see backend/lib/flutterwave.js), not that older
 * model. Needs FLW_CLIENT_ID/FLW_CLIENT_SECRET (v4 dashboard
 * credentials), not the old FLW_SECRET_KEY.
 *
 * Also newly required: a customer must be created first via
 * POST /customers, then referenced by the returned customer_id when
 * creating the virtual account — confirmed by support as mandatory,
 * a bare string won't work. NOTE: the exact required fields for
 * customer creation weren't given by support — the fields below are
 * an informed best guess based on the equivalent fields Flutterwave's
 * older API documented (email/firstname/lastname/phonenumber) and
 * have NOT been confirmed against the real API yet. If this call
 * fails, the actual required field names are the first thing to check.
 *
 * KYC requirement (BVN/NIN) and the synthetic-email approach are
 * unchanged from the original design rationale — see below.
 *
 * Auth: SUPER_ADMIN or OPERATIONS.
 * Body: { savings_plan_id, bvn_or_nin }
 */
'use strict';

const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { auditLog }               = require('../../lib/auditLog');
const { getFlutterwaveAccessToken, flutterwaveApiBase } = require('../../lib/flutterwave');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ['SUPER_ADMIN', 'OPERATIONS']))
    return err(403, 'SUPER_ADMIN or OPERATIONS role required to provision savings accounts');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const savingsPlanId = (body.savings_plan_id || '').trim();
  const bvnOrNin       = (body.bvn_or_nin || '').trim();

  if (!savingsPlanId) return err(400, 'savings_plan_id is required');
  if (!bvnOrNin)       return err(400, 'bvn_or_nin is required — needed to issue a static account');
  if (!/^\d{11}$/.test(bvnOrNin)) return err(400, 'bvn_or_nin must be an 11-digit number');

  const db = getServiceClient();

  const { data: plan } = await db.from('coop_savings_plans')
    .select('id, coop_id, member_id, flutterwave_tx_ref, coop_members(name, phone_normalized)')
    .eq('id', savingsPlanId).maybeSingle();
  if (!plan) return err(404, 'Savings plan not found');
  if (plan.flutterwave_tx_ref) return err(409, 'This plan already has a provisioned Flutterwave account');

  const member = plan.coop_members;
  const phoneDigits = (member.phone_normalized || '').replace(/\D/g, '');
  const syntheticEmail = `member.${phoneDigits}@savings.zillion.ng`;
  const reference = `ZILCOOP-${savingsPlanId.slice(0, 8)}-${Date.now()}`;
  const [firstname, ...rest] = (member.name || 'Member').split(' ');
  const lastname = rest.join(' ') || 'Member';

  let accessToken;
  try {
    accessToken = await getFlutterwaveAccessToken();
  } catch (e) {
    return err(500, `Flutterwave authentication failed: ${e.message}`);
  }

  const base = flutterwaveApiBase();

  // Step 1: create the customer — required before a virtual account can
  // reference one. Field names here are an informed guess, not yet
  // confirmed against the real API (see file header).
  let customerId;
  try {
    const custRes = await fetch(`${base}/customers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email:       syntheticEmail,
        phone_number: member.phone_normalized,
        name:          { first: firstname, last: lastname },
      }),
    });
    const custData = await custRes.json();
    customerId = custData.data?.id || custData.id;
    if (!custRes.ok || !customerId) {
      return err(502, `Flutterwave customer creation failed: ${custData.message || custData.error || 'unexpected response shape — check field names against their actual /customers requirements'}`);
    }
  } catch (e) {
    return err(502, `Failed to reach Flutterwave (customer creation): ${e.message}`);
  }

  // Step 2: create the static virtual account, referencing the real customer_id above.
  let flwResponse;
  try {
    const res = await fetch(`${base}/virtual-accounts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reference,
        customer_id:  customerId,
        amount:        1, // NGN static accounts accept any amount; Flutterwave's own docs use a nominal placeholder here
        currency:       'NGN',
        account_type:    'static',
        narration:        `Zillion Coop Savings — ${member.name || member.phone_normalized}`,
        bvn:               bvnOrNin,
      }),
    });
    flwResponse = await res.json();
    if (!res.ok) {
      return err(502, `Flutterwave rejected the virtual account request: ${flwResponse.message || flwResponse.error || 'unknown error'}`);
    }
  } catch (e) {
    return err(502, `Failed to reach Flutterwave (virtual account creation): ${e.message}`);
  }

  const accountData   = flwResponse.data || flwResponse;
  const accountNumber = accountData.account_number;
  const bankName        = accountData.bank_name;
  // TEMPORARY: expose the raw response so we can see the real v4 field
  // names rather than guessing again — bank_name came back null on the
  // first real test, meaning this guess was wrong. Remove once confirmed.
  const _debugRawFlutterwaveResponse = flwResponse;
  if (!accountNumber) return err(502, 'Flutterwave response missing account_number — unexpected shape, check integration');

  const { data: updated, error: updateErr } = await db.from('coop_savings_plans')
    .update({
      flutterwave_tx_ref:          reference,
      flutterwave_account_number:   accountNumber,
      flutterwave_bank_name:         bankName,
    })
    .eq('id', savingsPlanId)
    .select().single();

  if (updateErr) return err(500, `Provisioned with Flutterwave but failed to save locally: ${updateErr.message}. reference was ${reference} — contact support before retrying to avoid a duplicate account.`);

  await auditLog(db, {
    action:       'COOP_FLUTTERWAVE_ACCOUNT_PROVISIONED',
    username:     auth.payload.username || auth.payload.sub,
    role:         auth.payload.role,
    ip:           event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_savings_plan',
    resourceId:   savingsPlanId,
    requestBody:  { savings_plan_id: savingsPlanId }, // deliberately excludes bvn_or_nin
    result:       'SUCCESS',
  });

  return ok({
    success: true,
    plan:    updated,
    message: `Account provisioned: ${accountNumber} (${bankName}). Member should transfer their monthly saving here.`,
    _debug_raw_flutterwave_response: _debugRawFlutterwaveResponse,
  });
};
