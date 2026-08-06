/**
 * GET  /api/v1/admin/alerts            — list alerts (default: unresolved only)
 * POST /api/v1/admin/alerts            — resolve an alert
 * Body (POST): { alert_id, notes? }
 *
 * Auth: admin JWT — any authenticated admin role can view or acknowledge
 * alerts (read/dashboard-tier access, same reasoning as the other
 * admin dashboard views left unrestricted this session).
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { corsOrigin }       = require('../../lib/cors');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin(event) };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: hdr, body: '' };

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Admin access required');

  const db = getServiceClient();

  if (event.httpMethod === 'GET') {
    try {
      const showAll = (event.queryStringParameters || {}).all === 'true';
      let q = db.from('system_alerts').select('*').order('created_at', { ascending: false }).limit(100);
      if (!showAll) q = q.eq('resolved', false);
      const { data, error } = await q;
      if (error) return err(500, error.message);
      return ok({ alerts: data || [] });
    } catch (e) {
      return err(500, e.message);
    }
  }

  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return err(400, 'Invalid JSON'); }
    const { alert_id } = body;
    if (!alert_id) return err(400, 'alert_id is required');

    try {
      const { error } = await db.from('system_alerts').update({
        resolved: true,
        resolved_at: new Date().toISOString(),
        resolved_by: auth.payload.sub || auth.payload.username || 'admin',
      }).eq('alert_id', alert_id);
      if (error) return err(500, error.message);
      return ok({ success: true, alert_id });
    } catch (e) {
      return err(500, e.message);
    }
  }

  return err(405, 'Method Not Allowed');
};
