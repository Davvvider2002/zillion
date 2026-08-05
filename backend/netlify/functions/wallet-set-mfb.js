/**
 * POST /api/v1/wallet-set-mfb
 * Body: { mfb_id: string }
 *
 * Sets the customer's PREFERRED MFB for future activity (new top-ups,
 * default cash-out routing). This is deliberately separate from
 * coins.mfb_id, which is a permanent historical fact about which MFB's
 * float backed a specific coin — that is NEVER touched here or anywhere
 * else once a coin exists. Changing your preferred bank has zero effect
 * on coins you already hold.
 *
 * Auth: customer JWT (device_hash in `sub`)
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

  const deviceHash = auth.payload.sub;
  if (!deviceHash) return err(401, 'No device identity on token');

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );

  if (event.httpMethod === 'GET') {
    const { data: dev } = await db.from('devices')
      .select('preferred_mfb_id').eq('device_hash', deviceHash).maybeSingle();
    if (!dev?.preferred_mfb_id) return ok({ preferred_mfb_id: null, preferred_mfb_name: null });
    const { data: mfb } = await db.from('mfb_partners')
      .select('mfb_id, mfb_name').eq('mfb_id', dev.preferred_mfb_id).maybeSingle();
    return ok({ preferred_mfb_id: dev.preferred_mfb_id, preferred_mfb_name: mfb?.mfb_name || null });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return err(400, 'Invalid JSON'); }
  const { mfb_id } = body;
  if (!mfb_id) return err(400, 'mfb_id is required');


  // Validate the MFB is a real, active partner before setting it.
  const { data: mfb } = await db.from('mfb_partners')
    .select('mfb_id, mfb_name, status').eq('mfb_id', mfb_id).maybeSingle();
  if (!mfb || mfb.status !== 'ACTIVE') return err(400, 'Unknown or inactive MFB');

  const { error: updErr } = await db.from('devices').update({
    preferred_mfb_id: mfb_id,
    preferred_mfb_updated_at: new Date().toISOString(),
  }).eq('device_hash', deviceHash);

  if (updErr) return err(500, updErr.message);

  return ok({ success: true, preferred_mfb_id: mfb_id, preferred_mfb_name: mfb.mfb_name });
};
