/**
 * zillion/backend/netlify/functions/ajo-member-provision-account.js
 *
 * POST /api/v1/ajo-member-provision-account
 * Body: { scheme_id, bvn_or_nin }
 *
 * Creates a real, dedicated Flutterwave virtual account for the
 * caller's own membership in a scheme. Once provisioned, they
 * transfer their contribution to this account from any Nigerian bank
 * and ajo-flutterwave-webhook.js credits it automatically - this is
 * what makes "digital contribution" actually move money, rather than
 * the database-only tracking every other Ajo endpoint has used so far.
 *
 * Mirrors coop-provision-flutterwave-account.js's exact, proven
 * pattern (that implementation is explicitly documented as "confirmed
 * working end-to-end via real testing," including a field-name quirk
 * discovered the hard way: Flutterwave's response uses
 * account_bank_name, not bank_name) rather than re-deriving the
 * integration from Flutterwave's docs cold. One deliberate departure:
 * Coop's version requires internal SUPER_ADMIN/OPERATIONS staff to
 * provision it; this one is member-triggered, authenticated the same
 * way as every other Ajo endpoint (wallet zillion_id) - BVN/NIN is
 * the member's own sensitive data, not something staff should be
 * entering on their behalf.
 *
 * One dedicated account PER MEMBERSHIP, not one shared account per
 * scheme - a group of five members sharing a single account would
 * make it structurally impossible to tell whose contribution a given
 * incoming transfer actually was. This also means personal_savings
 * (always exactly one member) and group schemes use the identical
 * provisioning path, with no special-casing needed.
 *
 * Auth: wallet JWT (zillion_id) - must be an ACTIVE member of the scheme.
 */
'use strict';

const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT }              = require('../../lib/validators');
const { getFlutterwaveAccessToken, flutterwaveApiBase } = require('../../lib/flutterwave');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  const zillionId = auth.payload.zillion_id;
  if (!zillionId) return err(400, 'No zillion_id on this token — sign in through the wallet first');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const schemeId = (body.scheme_id || '').trim();
  const bvnOrNin = (body.bvn_or_nin || '').trim();
  if (!schemeId) return err(400, 'scheme_id is required');
  if (!bvnOrNin) return err(400, 'bvn_or_nin is required — needed to issue a dedicated account');
  if (!/^\d{11}$/.test(bvnOrNin)) return err(400, 'bvn_or_nin must be an 11-digit number');

  const db = getServiceClient();

  const { data: membership } = await db.from('ajo_scheme_members')
    .select('id, scheme_id, zillion_id, status, flutterwave_customer_id, flutterwave_tx_ref, ajo_schemes(name)')
    .eq('scheme_id', schemeId).eq('zillion_id', zillionId).maybeSingle();
  if (!membership || membership.status !== 'ACTIVE') return err(403, 'You are not an active member of this scheme');
  if (membership.flutterwave_tx_ref) return err(409, 'You already have a dedicated account for this scheme');

  const { data: identity } = await db.from('zillion_identities').select('phone_normalized').eq('zillion_id', zillionId).maybeSingle();
  const phoneNormalized = identity?.phone_normalized || '';
  const phoneDigits = phoneNormalized.replace(/\D/g, '');
  const syntheticEmail = `ajo.${phoneDigits}@savings.zillion.ng`;
  const reference = `ZILAJO-${membership.id.slice(0, 8)}-${Date.now()}`;
  // zillion_identities has no name field - unlike Coop members, an Ajo
  // member's real name is never captured anywhere in this build. BVN
  // is what actually carries identity verification for Flutterwave's
  // purposes; this is just what appears in their customer record.
  const firstname = 'Ajo';
  const lastname = 'Saver';

  let accessToken;
  try {
    accessToken = await getFlutterwaveAccessToken();
  } catch (e) {
    return err(500, `Flutterwave authentication failed: ${e.message}`);
  }

  const base = flutterwaveApiBase();

  // Reuse this member's existing Flutterwave customer if they already
  // have one from provisioning a different scheme - a customer
  // represents a PERSON, and creating a second one with the same
  // (phone-derived) email is correctly rejected as a duplicate.
  let customerId = membership.flutterwave_customer_id;
  if (!customerId) {
    const { data: anotherMembership } = await db.from('ajo_scheme_members')
      .select('flutterwave_customer_id').eq('zillion_id', zillionId).not('flutterwave_customer_id', 'is', null).limit(1).maybeSingle();
    customerId = anotherMembership?.flutterwave_customer_id || null;
  }

  if (!customerId) {
    try {
      const custRes = await fetch(`${base}/customers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: syntheticEmail,
          phone_number: phoneNormalized,
          name: { first: firstname, last: lastname },
        }),
      });
      const custData = await custRes.json();
      customerId = custData.data?.id || custData.id;

      // Same conflict-recovery path as the Coop implementation: an
      // earlier attempt may have created the customer on Flutterwave's
      // side but failed before we captured its ID.
      if (!custRes.ok && custData.error?.code === '10409') {
        const lookupRes = await fetch(`${base}/customers?email=${encodeURIComponent(syntheticEmail)}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const lookupData = await lookupRes.json();
        const found = (lookupData.data && lookupData.data[0]) || lookupData.data || null;
        customerId = found?.id || null;
        if (!customerId) {
          return { statusCode: 502, headers: hdr, body: JSON.stringify({
            error: 'A Flutterwave customer with this email already exists, but recovering its ID failed too.',
            _debug_raw_flutterwave_response: { create_attempt: custData, lookup_attempt: lookupData },
          }) };
        }
      } else if (!custRes.ok || !customerId) {
        const errDetail = typeof custData.message === 'string' ? custData.message
          : typeof custData.error === 'string' ? custData.error
          : JSON.stringify(custData);
        return err(502, `Flutterwave customer creation failed: ${errDetail}`);
      }
    } catch (e) {
      return err(502, `Failed to reach Flutterwave (customer creation): ${e.message}`);
    }
  }

  let flwResponse;
  try {
    const res = await fetch(`${base}/virtual-accounts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reference,
        customer_id: customerId,
        amount: 1, // NGN static accounts accept any amount - Flutterwave's own docs use this as a nominal placeholder
        currency: 'NGN',
        account_type: 'static',
        narration: `Zillion Ajo — ${membership.ajo_schemes?.name || 'Savings'}`,
        bvn: bvnOrNin,
      }),
    });
    flwResponse = await res.json();
    if (!res.ok) return err(502, `Flutterwave rejected the virtual account request: ${flwResponse.message || flwResponse.error || 'unknown error'}`);
  } catch (e) {
    return err(502, `Failed to reach Flutterwave (virtual account creation): ${e.message}`);
  }

  const accountData = flwResponse.data || flwResponse;
  const accountNumber = accountData.account_number;
  const bankName = accountData.account_bank_name; // confirmed field name, not bank_name
  if (!accountNumber) return err(502, 'Flutterwave response missing account_number — unexpected shape, check integration');

  const { data: updated, error: updateErr } = await db.from('ajo_scheme_members')
    .update({
      flutterwave_customer_id: customerId,
      flutterwave_tx_ref: reference,
      dedicated_account_number: accountNumber,
      dedicated_account_bank: bankName,
    })
    .eq('id', membership.id).select().single();

  if (updateErr) return err(500, `Provisioned with Flutterwave but failed to save locally: ${updateErr.message}. reference was ${reference} — contact support before retrying to avoid a duplicate account.`);

  return ok({
    success: true, membership: updated,
    account_number: accountNumber, bank_name: bankName,
    message: `Account ready: ${accountNumber} (${bankName}). Transfer your contribution here from any Nigerian bank.`,
  });
};
