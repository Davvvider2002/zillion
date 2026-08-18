/**
 * zillion/backend/netlify/functions/coop-provision-flutterwave-account.js
 *
 * POST /api/v1/coop-provision-flutterwave-account
 *
 * Admin-triggered: creates a permanent Flutterwave virtual account for
 * a member's savings plan. Once provisioned, the member pays their
 * monthly saving by transferring to this account from any Nigerian
 * bank — the webhook (coop-flutterwave-webhook.js) then credits it
 * automatically.
 *
 * NOTE: this makes a real outbound call to Flutterwave's API and has
 * not been tested against their live sandbox — no credentials exist
 * for that yet. Built precisely against their documented request/
 * response shape; needs a real FLW_SECRET_KEY to actually verify.
 *
 * KYC requirement: Flutterwave requires a BVN or NIN to issue a
 * PERMANENT (is_permanent:true) account — without one, they only
 * issue a temporary, single-use account, which defeats the point of
 * a recurring monthly savings payment. bvn/nin is therefore required
 * here, even though it's not collected anywhere in member activation
 * today — this is a genuine, deliberate KYC step at the point a
 * member's bank-linked savings actually gets set up, not something
 * silently skipped.
 *
 * Email requirement: Flutterwave's API requires a customer email, but
 * coop_members has no email field (phone-based identity throughout
 * Zillion). Rather than add a new required field to member activation
 * for an external API's sake, a synthetic address is generated from
 * the phone number — Flutterwave only uses this for its own internal
 * records, members never see or interact with it directly.
 *
 * Auth: SUPER_ADMIN or OPERATIONS.
 * Body: { savings_plan_id, bvn_or_nin }
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
    return err(403, 'SUPER_ADMIN or OPERATIONS role required to provision savings accounts');

  const secretKey = process.env.FLW_SECRET_KEY;
  if (!secretKey) return err(500, 'FLW_SECRET_KEY not configured — Flutterwave integration not yet set up');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const savingsPlanId = (body.savings_plan_id || '').trim();
  const bvnOrNin       = (body.bvn_or_nin || '').trim();

  if (!savingsPlanId) return err(400, 'savings_plan_id is required');
  if (!bvnOrNin)       return err(400, 'bvn_or_nin is required — Flutterwave requires this to issue a permanent account');
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
  const txRef = `ZILCOOP-${savingsPlanId.slice(0, 8)}-${Date.now()}`;

  const [firstname, ...rest] = (member.name || 'Member').split(' ');
  const lastname = rest.join(' ') || 'Member';

  let flwResponse;
  try {
    const res = await fetch('https://api.flutterwave.com/v3/virtual-account-numbers', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email:        syntheticEmail,
        tx_ref:        txRef,
        phonenumber:    member.phone_normalized,
        is_permanent:    true,
        firstname,
        lastname,
        bvn:              bvnOrNin,
        narration:         `Zillion Coop Savings — ${member.name || member.phone_normalized}`,
      }),
    });
    flwResponse = await res.json();
    if (flwResponse.status !== 'success') {
      return err(502, `Flutterwave rejected the request: ${flwResponse.message || 'unknown error'}`);
    }
  } catch (e) {
    return err(502, `Failed to reach Flutterwave: ${e.message}`);
  }

  const accountNumber = flwResponse.data?.account_number;
  const bankName       = flwResponse.data?.bank_name;
  if (!accountNumber) return err(502, 'Flutterwave response missing account_number — unexpected shape, check integration');

  const { data: updated, error: updateErr } = await db.from('coop_savings_plans')
    .update({
      flutterwave_tx_ref:          txRef,
      flutterwave_account_number:   accountNumber,
      flutterwave_bank_name:         bankName,
    })
    .eq('id', savingsPlanId)
    .select().single();

  if (updateErr) return err(500, `Provisioned with Flutterwave but failed to save locally: ${updateErr.message}. tx_ref was ${txRef} — contact support before retrying to avoid a duplicate account.`);

  await auditLog(db, {
    action:       'COOP_FLUTTERWAVE_ACCOUNT_PROVISIONED',
    username:     auth.payload.username || auth.payload.sub,
    role:         auth.payload.role,
    ip:           event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_savings_plan',
    resourceId:   savingsPlanId,
    requestBody:  { savings_plan_id: savingsPlanId }, // deliberately excludes bvn_or_nin from the audit log
    result:       'SUCCESS',
  });

  return ok({
    success: true,
    plan:    updated,
    message: `Account provisioned: ${accountNumber} (${bankName}). Member should transfer their monthly saving here.`,
  });
};
