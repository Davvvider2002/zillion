/**
 * GET /api/v1/mfb-list
 * Returns active MFB partners for bank-selection pickers in wallet,
 * merchant, and agent apps. Read-only, minimal fields — no auth
 * required since this is just a public list of participating banks,
 * not customer data.
 */
'use strict';

const { corsOrigin } = require('../../lib/cors');

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin(event) };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: hdr, body: '' };
  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  try {
    const db = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
      { auth: { persistSession: false } }
    );

    const { data, error } = await db
      .from('mfb_partners')
      .select('mfb_id, mfb_name, state, tier, status')
      .eq('status', 'ACTIVE')
      .order('mfb_name', { ascending: true });

    if (error) {
      // Table may not exist in early environments — degrade gracefully
      // rather than breaking the pickers that call this.
      return ok({ mfbs: [] });
    }

    return ok({ mfbs: data || [] });
  } catch (e) {
    return err(500, e.message);
  }
};
