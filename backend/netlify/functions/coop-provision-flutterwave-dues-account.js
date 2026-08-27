/**
 * zillion/backend/netlify/functions/coop-provision-flutterwave-dues-account.js
 *
 * POST /api/v1/coop-provision-flutterwave-dues-account
 *
 * Admin-triggered: creates a static Flutterwave virtual account for a
 * member's dues payments. Same proven pattern as
 * coop-provision-flutterwave-account.js (savings) — OAuth token,
 * customer reuse/conflict-recovery, static virtual account creation —
 * adapted to operate per-member directly rather than per-plan, since
 * dues isn't tied to a specific savings goal the way a plan is.
 *
 * Reuses the SAME Flutterwave customer as the member's savings account
 * if they already have one (flutterwave_customer_id on coop_members) —
 * a customer represents a person, not a purpose, so one person should
 * never have two customer records regardless of how many different
 * things they're paying for.
 *
 * Auth: SUPER_ADMIN or OPERATIONS.
 * Body: { member_id, bvn_or_nin }
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
    return err(403, 'SUPER_ADMIN or OPERATIONS role required to provision dues accounts');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const memberId  = (body.member_id || '').trim();
  const bvnOrNin   = (body.bvn_or_nin || '').trim();

  if (!memberId)  return err(400, 'member_id is required');
  if (!bvnOrNin)   return err(400, 'bvn_or_nin is required — needed to issue a static account');
  if (!/^\d{11}$/.test(bvnOrNin)) return err(400, 'bvn_or_nin must be an 11-digit number');

  const db = getServiceClient();

  const { data: member } = await db.from('coop_members')
    .select('id, coop_id, name, phone_normalized, flutterwave_customer_id, flutterwave_dues_tx_ref')
    .eq('id', memberId).maybeSingle();
  if (!member) return err(404, 'Member not found');
  if (member.flutterwave_dues_tx_ref) return err(409, 'This member already has a provisioned dues account');

  const phoneDigits = (member.phone_normalized || '').replace(/\D/g, '');
  const syntheticEmail = `member.${phoneDigits}@savings.zillion.ng`; // same address as savings — one person, one customer
  const reference = `ZILDUES-${memberId.slice(0, 8)}-${Date.now()}`;
  const [firstname, ...rest] = (member.name || 'Member').split(' ');
  const lastname = rest.join(' ') || 'Member';

  let accessToken;
  try { accessToken = await getFlutterwaveAccessToken(); }
  catch (e) { return err(500, `Flutterwave authentication failed: ${e.message}`); }

  const base = flutterwaveApiBase();

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

      if (!custRes.ok && custData.error?.code === '10409') {
        const lookupRes = await fetch(`${base}/customers?email=${encodeURIComponent(syntheticEmail)}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const lookupData = await lookupRes.json();
        const found = (lookupData.data && lookupData.data[0]) || lookupData.data || null;
        customerId = found?.id || null;
        if (!customerId) {
          return { statusCode: 502, headers: hdr, body: JSON.stringify({
            error: 'Customer already exists on Flutterwave, but looking it up by email also failed.',
            _debug_raw_flutterwave_response: { create_attempt: custData, lookup_attempt: lookupData },
          }) };
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

    await db.from('coop_members').update({ flutterwave_customer_id: customerId }).eq('id', member.id);
  }

  let flwResponse;
  try {
    const res = await fetch(`${base}/virtual-accounts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reference,
        customer_id:  customerId,
        amount:        1,
        currency:       'NGN',
        account_type:    'static',
        narration:        `Zillion Coop Dues — ${member.name || member.phone_normalized}`,
        bvn:               bvnOrNin,
      }),
    });
    flwResponse = await res.json();
    if (!res.ok) return err(502, `Flutterwave rejected the virtual account request: ${flwResponse.message || flwResponse.error || 'unknown error'}`);
  } catch (e) {
    return err(502, `Failed to reach Flutterwave (virtual account creation): ${e.message}`);
  }

  const accountData   = flwResponse.data || flwResponse;
  const accountNumber = accountData.account_number;
  const bankName        = accountData.account_bank_name;
  if (!accountNumber) return err(502, 'Flutterwave response missing account_number — unexpected shape, check integration');

  const { data: updated, error: updateErr } = await db.from('coop_members')
    .update({
      flutterwave_dues_tx_ref:          reference,
      flutterwave_dues_account_number:   accountNumber,
      flutterwave_dues_bank_name:         bankName,
    })
    .eq('id', memberId)
    .select().single();

  if (updateErr) return err(500, `Provisioned with Flutterwave but failed to save locally: ${updateErr.message}. reference was ${reference} — contact support before retrying.`);

  await auditLog(db, {
    action:       'COOP_DUES_ACCOUNT_PROVISIONED',
    username:     auth.payload.username || auth.payload.sub,
    role:         auth.payload.role,
    ip:           event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_member',
    resourceId:   memberId,
    requestBody:  { member_id: memberId },
    result:       'SUCCESS',
  });

  return ok({
    success: true,
    member:  updated,
    message: `Dues account provisioned: ${accountNumber} (${bankName}).`,
  });
};
