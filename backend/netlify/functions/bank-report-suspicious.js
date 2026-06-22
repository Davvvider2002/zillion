/**
 * POST /api/v1/bank/report-suspicious
 * Sprint 3: Bank flags a customer for AML review → Zillion freezes wallet coins.
 * Auth: Bank API key
 * Body: { customer_id, reason, reference? }
 */
'use strict';

const { createClient } = require('@supabase/supabase-js');
const { verifyBankAuth } = require('../../lib/bank-auth');

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

  const { customer_id, reason, reference = '' } = body;
  if (!customer_id) return err(400, 'Missing customer_id');
  if (!reason)      return err(400, 'Missing reason');

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );

  const now = new Date().toISOString();

  // Freeze all HELD coins belonging to this device
  const { data: frozen } = await db.from('coins')
    .update({ status: 'FROZEN', updated_at: now })
    .eq('holder_hash', customer_id).in('status', ['HELD', 'ISSUED'])
    .select('coin_id, amount');

  // Deactivate device
  try {
    await db.from('devices').update({ status: 'SUSPENDED' })
      .eq('device_hash', customer_id);
  } catch(e) { console.warn('[bank-suspicious] device suspend warn:', e.message); }

  // Log fraud event
  const caseId = `CASE-${Date.now()}-${customer_id.slice(0, 8)}`;
  try {
    await db.from('fraud_events').insert({
      device_hash: customer_id,
      event_type:  'BANK_SUSPICIOUS_REPORT',
      coin_id:     null,
      resolved:    false,
      detected_at: now,
    });
  } catch(e) { console.warn('[bank-suspicious] fraud_events warn:', e.message); }

  const frozenCount = frozen?.length || 0;
  const frozenKobo  = (frozen || []).reduce((s, c) => s + (c.amount || 0), 0);

  console.log(`[bank-suspicious] ⚠️ ${auth.bank_id} flagged ${customer_id} — ${frozenCount} coins frozen`);

  return ok({
    success:       true,
    case_id:       caseId,
    customer_id,
    coins_frozen:  frozenCount,
    amount_frozen_kobo: frozenKobo,
    wallet_suspended:   true,
    reason,
    reported_by:   auth.bank_id,
    reported_at:   now,
    message:       `${frozenCount} coin(s) frozen. Wallet suspended pending review. Case: ${caseId}`,
  });
};
