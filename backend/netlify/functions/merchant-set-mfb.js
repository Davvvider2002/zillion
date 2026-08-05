/**
 * POST /api/v1/merchant-set-mfb
 * Body: { mfb_id: string }
 *
 * Sets the merchant's PREFERRED MFB for future activity (default cash-out
 * routing). Separate from any per-coin MFB attribution — existing coins
 * and past transactions are never touched by this.
 *
 * Auth: merchant JWT (merchant_id in payload)
 */
'use strict';

const { corsOrigin } = require('../../lib/cors');

const { createClient } = require('@supabase/supabase-js');
const { verifyJWT }    = require('../../lib/validators');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin(event) };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: hdr, body: '' };
  if (!['GET', 'POST'].includes(event.httpMethod)) return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, auth.reason);

  const merchantId = auth.payload.merchant_id || auth.payload.sub;
  if (!merchantId) return err(401, 'No merchant identity on token');

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );

  if (event.httpMethod === 'GET') {
    const { data: mer } = await db.from('merchants')
      .select('preferred_mfb_id').eq('merchant_id', merchantId).maybeSingle();
    if (!mer?.preferred_mfb_id) return ok({ preferred_mfb_id: null, preferred_mfb_name: null });
    const { data: mfb } = await db.from('mfb_partners')
      .select('mfb_id, mfb_name').eq('mfb_id', mer.preferred_mfb_id).maybeSingle();
    return ok({ preferred_mfb_id: mer.preferred_mfb_id, preferred_mfb_name: mfb?.mfb_name || null });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return err(400, 'Invalid JSON'); }
  const { mfb_id } = body;
  if (!mfb_id) return err(400, 'mfb_id is required');


  const { data: mfb } = await db.from('mfb_partners')
    .select('mfb_id, mfb_name, status').eq('mfb_id', mfb_id).maybeSingle();
  if (!mfb || mfb.status !== 'ACTIVE') return err(400, 'Unknown or inactive MFB');

  const { error: updErr } = await db.from('merchants').update({
    preferred_mfb_id: mfb_id,
    preferred_mfb_updated_at: new Date().toISOString(),
  }).eq('merchant_id', merchantId);

  if (updErr) return err(500, updErr.message);

  return ok({ success: true, preferred_mfb_id: mfb_id, preferred_mfb_name: mfb.mfb_name });
};
