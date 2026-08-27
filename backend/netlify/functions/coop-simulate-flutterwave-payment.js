/**
 * zillion/backend/netlify/functions/coop-simulate-flutterwave-payment.js
 *
 * POST /api/v1/coop-simulate-flutterwave-payment
 *
 * SANDBOX-ONLY TEST ENDPOINT — not part of the production flow. Uses
 * Flutterwave's X-Scenario-Key mechanism (confirmed directly by their
 * support) to create a virtual account that ALSO simulates an
 * immediate funding event, triggering a real charge.completed webhook
 * to our real webhook receiver (coop-flutterwave-webhook.js).
 *
 * This is deliberately a SEPARATE file from
 * coop-provision-flutterwave-account.js rather than a flag on it —
 * the scenario-simulation headers must never be sent in production,
 * and keeping this fully separate means there's no risk of a
 * misconfigured flag accidentally enabling test-mode behavior on a
 * real account.
 *
 * Confirm Flutterwave's dashboard has this environment's webhook URL
 * saved (Settings > Webhooks) before using this — otherwise the
 * simulated charge will succeed on Flutterwave's side but nothing
 * will arrive at our receiver.
 *
 * Auth: SUPER_ADMIN or OPERATIONS.
 * Body: { savings_plan_id, bvn_or_nin, amount_kobo, scenario }
 *   scenario: "approved" (default) | "failed"
 */
'use strict';

const crypto = require('crypto');
const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { getFlutterwaveAccessToken, flutterwaveApiBase } = require('../../lib/flutterwave');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ['SUPER_ADMIN', 'OPERATIONS']))
    return err(403, 'SUPER_ADMIN or OPERATIONS role required');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const savingsPlanId = (body.savings_plan_id || '').trim();
  const bvnOrNin       = (body.bvn_or_nin || '').trim();
  const amountKobo      = Number.isInteger(body.amount_kobo) ? body.amount_kobo : 500000;
  const scenario         = body.scenario === 'failed' ? 'failed' : 'approved';

  if (!savingsPlanId) return err(400, 'savings_plan_id is required');
  if (!bvnOrNin)       return err(400, 'bvn_or_nin is required');

  const db = getServiceClient();

  const { data: plan } = await db.from('coop_savings_plans')
    .select('id, coop_id, member_id, coop_members(id, name, phone_normalized, flutterwave_customer_id)')
    .eq('id', savingsPlanId).maybeSingle();
  if (!plan) return err(404, 'Savings plan not found');
  const currentRef = (await db.from('coop_savings_plans').select('flutterwave_tx_ref').eq('id', savingsPlanId).single()).data?.flutterwave_tx_ref;
  if (currentRef) return err(409, `This plan already has a REAL provisioned account (${currentRef}). Use a fresh savings plan for simulation testing — simulation always creates a new account/reference, and reusing this one would overwrite the working real account's reference.`);

  const member = plan.coop_members;
  const phoneDigits = (member.phone_normalized || '').replace(/\D/g, '');
  const syntheticEmail = `member.${phoneDigits}@savings.zillion.ng`;
  const reference = `ZILCOOP-SIM-${savingsPlanId.slice(0, 8)}-${Date.now()}`;
  const [firstname, ...rest] = (member.name || 'Member').split(' ');
  const lastname = rest.join(' ') || 'Member';

  let accessToken;
  try { accessToken = await getFlutterwaveAccessToken(); }
  catch (e) { return err(500, `Flutterwave authentication failed: ${e.message}`); }

  const base = flutterwaveApiBase();

  // Reuse the member's existing customer if they have one (same
  // conflict-recovery pattern as the real provisioning endpoint).
  let customerId = member.flutterwave_customer_id || null;
  if (!customerId) {
    const custRes = await fetch(`${base}/customers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: syntheticEmail, phone_number: member.phone_normalized, name: { first: firstname, last: lastname } }),
    });
    const custData = await custRes.json();
    customerId = custData.data?.id || custData.id;
    if (!custRes.ok && custData.error?.code === '10409') {
      const lookupRes = await fetch(`${base}/customers?email=${encodeURIComponent(syntheticEmail)}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const lookupData = await lookupRes.json();
      customerId = (lookupData.data && lookupData.data[0]?.id) || null;
    }
    if (!customerId) return err(502, `Could not resolve a Flutterwave customer for simulation: ${JSON.stringify(custData)}`);
    await db.from('coop_members').update({ flutterwave_customer_id: customerId }).eq('id', member.id);
  }

  // The actual simulation: X-Scenario-Key on account creation triggers
  // an immediate simulated funding event, per Flutterwave support.
  let flwResponse;
  try {
    const res = await fetch(`${base}/virtual-accounts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Scenario-Key': `issuer:${scenario}`,
        'X-Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify({
        reference,
        customer_id: customerId,
        amount:       Math.round(amountKobo / 100),
        currency:      'NGN',
        account_type:   'static',
        narration:       `SIMULATION — Zillion Coop Savings — ${member.name || member.phone_normalized}`,
        bvn:              bvnOrNin,
      }),
    });
    flwResponse = await res.json();
    if (!res.ok) return err(502, `Simulation request rejected: ${JSON.stringify(flwResponse)}`);
  } catch (e) {
    return err(502, `Failed to reach Flutterwave: ${e.message}`);
  }

  // Critical: without this, the webhook receiver's lookup by
  // flutterwave_tx_ref would find nothing when the simulated charge
  // arrives — the webhook would be silently ignored, not credited.
  await db.from('coop_savings_plans').update({ flutterwave_tx_ref: reference }).eq('id', savingsPlanId);

  return ok({
    success: true,
    scenario,
    reference,
    flutterwave_response: flwResponse,
    message: `Simulated ${scenario} payment sent. If your webhook URL is correctly configured in the Flutterwave dashboard, check coop-member-status for this member in a few seconds — the savings ledger should show a new webhook_flutterwave entry.`,
  });
};
