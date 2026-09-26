/**
 * zillion/backend/netlify/functions/ajo-configure-collector-joining-fee.js
 *
 * POST /api/v1/ajo-configure-collector-joining-fee
 * Body: { joining_fee_kobo }
 *
 * Any Ajo admin's self-service setting for the joining fee charged to
 * a prospect becoming a collector via their own recruitment link
 * (ajo-collector-public-join-init.js). Unlike Coop's equivalent
 * setting, there is no free option here - the fee is compulsory, per
 * how this was specified, so this rejects zero rather than treating
 * it as "free to join."
 *
 * admin_zillion_id is always the caller's own token - never accepted
 * from the client, so an admin can only ever configure their own fee.
 * Upsert, not update-only: this is very likely the first time this
 * admin has ever set a fee, since there's no separate "create" step -
 * setting a fee for the first time and changing an existing one are
 * the same action.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  const zillionId = auth.payload.zillion_id;
  if (!zillionId) return err(400, 'No zillion_id on this token — sign in through the wallet first');

  const db = getServiceClient();

  if (event.httpMethod === 'GET') {
    const { data: settings } = await db.from('ajo_collector_recruitment_settings')
      .select('joining_fee_kobo').eq('admin_zillion_id', zillionId).maybeSingle();
    return ok({ joining_fee_kobo: settings?.joining_fee_kobo || null, admin_zillion_id: zillionId });
  }

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const feeKobo = Number(body.joining_fee_kobo);
  if (!Number.isInteger(feeKobo) || feeKobo <= 0)
    return err(400, 'joining_fee_kobo must be a positive whole number — the joining fee is compulsory and cannot be set to free');

  const { data: upserted, error: upsertErr } = await db.from('ajo_collector_recruitment_settings')
    .upsert({ admin_zillion_id: zillionId, joining_fee_kobo: feeKobo, updated_at: new Date().toISOString() }, { onConflict: 'admin_zillion_id' })
    .select().single();

  if (upsertErr) return err(500, `Failed to set joining fee: ${upsertErr.message}`);

  return ok({ success: true, settings: upserted });
};
