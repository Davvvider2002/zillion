/**
 * GET /api/v1/compliance/str
 * Sprint 3: CBN Suspicious Transaction Report data.
 * Returns all fraud_events flagged as suspicious in the specified period.
 * Auth: Admin JWT
 * Query: ?from=2026-06-01&to=2026-06-30
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b    => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m)=> ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid)                   return err(401, auth.reason);
  if (auth.payload.role !== 'admin') return err(403, 'Admin access required');

  const { from, to, resolved } = event.queryStringParameters || {};
  if (!from || !to) return err(400, 'Missing from and to query parameters (YYYY-MM-DD)');

  const fromDate = new Date(from + 'T00:00:00.000Z');
  const toDate   = new Date(to   + 'T23:59:59.999Z');
  if (isNaN(fromDate) || isNaN(toDate)) return err(400, 'Invalid date format — use YYYY-MM-DD');

  const db = getServiceClient();

  let query = db.from('fraud_events')
    .select('event_id, device_hash, event_type, coin_id, detected_at, resolved, resolution_note, resolved_at')
    .gte('detected_at', fromDate.toISOString())
    .lte('detected_at', toDate.toISOString())
    .order('detected_at', { ascending: false });

  // Optional filter: only unresolved
  if (resolved === 'false') query = query.eq('resolved', false);
  if (resolved === 'true')  query = query.eq('resolved', true);

  const { data: events, error } = await query;
  if (error) return err(500, `STR query failed: ${error.message}`);

  const suspicious = (events || []).map(e => ({
    case_id:         `STR-${(e.event_id || '').slice(0, 8).toUpperCase()}`,
    event_type:      e.event_type,
    device_hash:     e.device_hash,
    coin_id:         e.coin_id,
    resolution_note: e.resolution_note || null,
    resolved:        e.resolved,
    detected_at:     e.detected_at,
    requires_str:    ['DOUBLE_SPEND','BANK_SUSPICIOUS_REPORT','ADMIN_FREEZE'].includes(e.event_type),
  }));

  const requiresStr = suspicious.filter(e => e.requires_str);

  return ok({
    report_type:      'SUSPICIOUS_TRANSACTION_REPORT',
    reporting_entity: 'ZILLION',
    period_from:      from,
    period_to:        to,
    total_events:     suspicious.length,
    requires_str_count: requiresStr.length,
    suspicious_events:  suspicious,
    str_events:         requiresStr,
    generated_at:     new Date().toISOString(),
    note: 'STR events must be reported to NFIU within 24 hours of detection.',
  });
};
