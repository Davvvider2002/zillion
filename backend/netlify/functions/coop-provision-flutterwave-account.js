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
 * A customer must be created first via POST /customers, then
 * referenced by the returned customer_id when creating the virtual
 * account. Confirmed working end-to-end via real testing — a member's
 * FIRST plan creates a customer and stores its ID on coop_members;
 * any LATER plan for the same member reuses it (Flutterwave correctly
 * rejects a second customer with the same email as a genuine
 * duplicate — a customer represents a person, not a savings goal).
 * If that reuse lookup is ever missing (e.g. an earlier attempt
 * created a customer on Flutterwave's side but failed before our own
 * save step ran), the RESOURCE_CONFLICT/10409 recovery path below
 * searches GET /customers?email=... to recover the existing ID —
 * this exact pattern was confirmed as the recommended approach by
 * Flutterwave's own support.
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
    .select('id, coop_id, member_id, flutterwave_tx_ref, coop_members(id, name, phone_normalized, flutterwave_customer_id)')
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

  // Step 1: reuse the member's existing Flutterwave customer if they
  // already have one from a previous plan — a customer represents a
  // PERSON, not a savings goal, and creating a second one with the same
  // (phone-derived) email correctly gets rejected by Flutterwave as a
  // duplicate. Only create a new customer on someone's genuinely first
  // provisioning.
  let customerId = member.flutterwave_customer_id || null;

  if (!customerId) {
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

      // Specific recovery path for exactly this conflict: an earlier
      // attempt already created a customer with this email on
      // Flutterwave's side, but we never captured its ID (that attempt
      // failed before reaching our save step). Try to look it up rather
      // than fail outright. NOTE: the lookup shape here (GET
      // /customers?email=...) is an informed guess, not yet confirmed —
      // if this also fails, the error below will say so honestly rather
      // than silently treating a failed recovery as success.
      if (!custRes.ok && custData.error?.code === '10409') {
        try {
          const lookupRes = await fetch(`${base}/customers?email=${encodeURIComponent(syntheticEmail)}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          const lookupData = await lookupRes.json();
          const found = (lookupData.data && lookupData.data[0]) || lookupData.data || null;
          customerId = found?.id || null;
          if (!customerId) {
            return { statusCode: 502, headers: hdr, body: JSON.stringify({
              error: 'Customer already exists on Flutterwave, but looking it up by email to recover its ID also failed. This specific recovery path needs Flutterwave support to confirm the correct lookup method.',
              _debug_raw_flutterwave_response: { create_attempt: custData, lookup_attempt: lookupData },
            }) };
          }
        } catch (e) {
          return err(502, `Customer conflict recovery failed: ${e.message}`);
        }
      } else if (!custRes.ok || !customerId) {
        const errDetail = typeof custData.message === 'string' ? custData.message
          : typeof custData.error === 'string' ? custData.error
          : JSON.stringify(custData);
        return { statusCode: 502, headers: hdr, body: JSON.stringify({
          error: `Flutterwave customer creation failed: ${errDetail}`,
          _debug_raw_flutterwave_response: custData,
        }) };
      }
    } catch (e) {
      return err(502, `Failed to reach Flutterwave (customer creation): ${e.message}`);
    }

    // Save it on the member's own record — this is what makes their
    // NEXT savings plan (if any) reuse this same customer instead of
    // hitting the same conflict again.
    await db.from('coop_members').update({ flutterwave_customer_id: customerId }).eq('id', member.id);
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
  // FIX: confirmed via a real response — the field is account_bank_name,
  // not bank_name. Was returning null before this was confirmed.
  const bankName        = accountData.account_bank_name;
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
  });
};
