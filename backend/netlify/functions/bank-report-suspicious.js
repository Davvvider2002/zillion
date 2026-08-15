/**
 * POST /api/v1/bank/report-suspicious
 * Sprint 3: Bank flags a customer for AML review → Zillion freezes wallet coins.
 * Auth: Bank API key
 * Body: { customer_phone, reason, reference? }  — customer_phone is the
 * recommended and reliable way to identify the customer (see below for
 * why a raw customer_id is not).
 *
 * FIX: previously took an opaque customer_id and used it directly against
 * BOTH coins.holder_hash and devices.device_hash — but those two tables
 * use genuinely different hash schemes (coins.holder_hash is plain
 * SHA256(phone); devices.device_hash/phone_hash is HMAC-SHA256(service
 * key, phone)). A single opaque ID could never correctly match both,
 * meaning coin-freezing was silently failing (0 rows matched, no error)
 * even when the customer was correctly identified via the devices table.
 * Now derives both hashes independently and correctly from a phone
 * number, the same proven pattern bank-fund-customer-wallet.js already
 * uses. customer_id is still accepted for backward compatibility, but
 * only ever applied directly to devices.device_hash — coin freezing is
 * skipped entirely in that path rather than silently doing nothing while
 * reporting success, since a silent no-op on a fraud freeze is worse
 * than an explicit "this path can't do that."
 */
'use strict';

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { verifyBankAuth } = require('../../lib/bank-auth');

function normalisePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('234')) return '+' + digits;
  if (digits.startsWith('0'))   return '+234' + digits.slice(1);
  return '+' + digits;
}

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b    => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m)=> ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyBankAuth(event);
  if (!auth.valid) return err(401, auth.reason);

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const { customer_phone, customer_id, reason, reference = '' } = body;
  if (!customer_phone && !customer_id)
    return err(400, 'Provide customer_phone (recommended) or customer_id');
  if (!reason) return err(400, 'Missing reason');
  if (customer_phone && !process.env.SUPABASE_SERVICE_KEY)
    return err(500, 'Server misconfigured: SUPABASE_SERVICE_KEY is not set');

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );

  const now = new Date().toISOString();
  let holderHash, deviceHash, coinFreezeSkipped = false;

  if (customer_phone) {
    const phone = normalisePhone(customer_phone);
    // Matches coins.holder_hash's scheme exactly (see bank-fund-customer-wallet.js)
    holderHash = crypto.createHash('sha256').update(phone).digest('hex');
    // Matches devices.device_hash/phone_hash's scheme exactly (see bank-activate-customer.js)
    deviceHash = crypto.createHmac('sha256', process.env.SUPABASE_SERVICE_KEY).update(phone).digest('hex');
  } else {
    // Legacy path: a raw ID was provided directly. We don't know which
    // scheme it's in, so it's only applied to devices (matching the
    // original behaviour for that table) — coin freezing is explicitly
    // skipped rather than silently running a query that would never match.
    deviceHash = customer_id;
    coinFreezeSkipped = true;
  }

  // Freeze all HELD coins belonging to this customer
  let frozen = [];
  if (!coinFreezeSkipped) {
    const { data } = await db.from('coins')
      .update({ status: 'FROZEN', updated_at: now })
      .eq('holder_hash', holderHash).in('status', ['HELD', 'ISSUED'])
      .select('coin_id, amount');
    frozen = data || [];
  }

  // Deactivate device
  try {
    await db.from('devices').update({ status: 'SUSPENDED' })
      .eq('device_hash', deviceHash);
  } catch(e) { console.warn('[bank-suspicious] device suspend warn:', e.message); }

  // Log fraud event
  const caseId = `CASE-${Date.now()}-${deviceHash.slice(0, 8)}`;
  try {
    await db.from('fraud_events').insert({
      device_hash: deviceHash,
      event_type:  'BANK_SUSPICIOUS_REPORT',
      coin_id:     null,
      resolved:    false,
      detected_at: now,
    });
  } catch(e) { console.warn('[bank-suspicious] fraud_events warn:', e.message); }

  const frozenCount = frozen?.length || 0;
  const frozenKobo  = (frozen || []).reduce((s, c) => s + (c.amount || 0), 0);

  console.log(`[bank-suspicious] ⚠️ ${auth.bank_id} flagged ${deviceHash} — ${frozenCount} coins frozen${coinFreezeSkipped ? ' (SKIPPED: legacy customer_id path, phone not provided)' : ''}`);

  return ok({
    success:            true,
    case_id:             caseId,
    coins_frozen:         frozenCount,
    amount_frozen_kobo:   frozenKobo,
    coin_freeze_skipped:  coinFreezeSkipped,
    wallet_suspended:     true,
    reason,
    reported_by:          auth.bank_id,
    reported_at:          now,
    message: coinFreezeSkipped
      ? `Wallet suspended. Coin freeze SKIPPED — resend with customer_phone instead of customer_id to freeze held coins. Case: ${caseId}`
      : `${frozenCount} coin(s) frozen. Wallet suspended pending review. Case: ${caseId}`,
  });
};
