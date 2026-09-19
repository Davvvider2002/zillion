/**
 * zillion/backend/netlify/functions/ajo-collector-reconcile.js
 *
 * POST /api/v1/ajo-collector-reconcile
 * Body: { scheme_id, actual_kobo, reconciliation_date? }
 *
 * A collector's end-of-day reconciliation: expected_kobo is computed
 * fresh from the real ajo_contributions rows they recorded (source
 * 'cash', recorded_by them) for this scheme on the given date - never
 * a number the collector supplies themselves, since the whole point
 * is catching a mismatch between what they say they collected and
 * what the system actually has on record. variance_kobo is a
 * GENERATED column in the schema (actual - expected), computed by
 * the database itself, not duplicated here.
 *
 * reconciliation_date defaults to today (server date) if omitted -
 * the normal end-of-day case. A collector can only reconcile for
 * schemes they are currently an ACTIVE collector on.
 *
 * Auth: wallet JWT (zillion_id) - must be an ACTIVE collector for
 * this scheme.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  const collectorZillionId = auth.payload.zillion_id;
  if (!collectorZillionId) return err(400, 'No zillion_id on this token — sign in through the wallet first');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const schemeId = (body.scheme_id || '').trim();
  const actualKobo = Number.isInteger(body.actual_kobo) && body.actual_kobo >= 0 ? body.actual_kobo : null;
  const reconciliationDate = (body.reconciliation_date || new Date().toISOString().slice(0, 10)).trim();

  if (!schemeId) return err(400, 'scheme_id is required');
  if (actualKobo === null) return err(400, 'actual_kobo must be a non-negative integer');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reconciliationDate)) return err(400, 'reconciliation_date must be YYYY-MM-DD');

  const db = getServiceClient();

  const { data: collector } = await db.from('ajo_collectors').select('id').eq('scheme_id', schemeId).eq('zillion_id', collectorZillionId).eq('status', 'ACTIVE').maybeSingle();
  if (!collector) return err(403, 'You are not an active collector for this scheme');

  // Expected = every cash contribution THIS collector recorded, for
  // THIS scheme, dated on THIS reconciliation date - computed fresh
  // against the real rows, never taken on trust from the request body.
  const dayStart = `${reconciliationDate}T00:00:00.000Z`;
  const dayEnd = `${reconciliationDate}T23:59:59.999Z`;
  const { data: cashContributions } = await db.from('ajo_contributions')
    .select('amount_kobo, cycle_id, ajo_cycles!inner(scheme_id)')
    .eq('recorded_by', collectorZillionId).eq('source', 'cash')
    .eq('ajo_cycles.scheme_id', schemeId)
    .gte('recorded_at', dayStart).lte('recorded_at', dayEnd);

  const expectedKobo = (cashContributions || []).reduce((s, c) => s + c.amount_kobo, 0);

  const { data: logEntry, error } = await db.from('ajo_reconciliation_log').insert({
    collector_id: collector.id, reconciliation_date: reconciliationDate,
    expected_kobo: expectedKobo, actual_kobo: actualKobo,
  }).select().single();
  if (error) return err(500, `Failed to record reconciliation: ${error.message}`);

  return ok({
    success: true, reconciliation: logEntry,
    balanced: logEntry.variance_kobo === 0,
  });
};
