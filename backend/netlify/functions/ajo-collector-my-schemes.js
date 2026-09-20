/**
 * zillion/backend/netlify/functions/ajo-collector-my-schemes.js
 *
 * GET /api/v1/ajo-collector-my-schemes
 *
 * Lists every scheme the caller's zillion_id is currently an ACTIVE
 * collector for - the missing piece that made the entire collector
 * feature invisible: ajo-collector-record-cash.js and
 * ajo-collector-reconcile.js have existed since early in this build,
 * but nothing ever let a collector discover which schemes they were
 * even assigned to in the first place.
 *
 * Auth: wallet JWT (zillion_id).
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  const zillionId = auth.payload.zillion_id;
  if (!zillionId) return ok({ assignments: [] });

  const db = getServiceClient();
  const { data: collectorRows } = await db.from('ajo_collectors')
    .select('id, scheme_id, assigned_at, ajo_schemes(name, scheme_type, contribution_amount_kobo, status)')
    .eq('zillion_id', zillionId).eq('status', 'ACTIVE');

  const assignments = await Promise.all((collectorRows || []).map(async (c) => {
    const today = new Date().toISOString().slice(0, 10);
    const { data: todaysReconciliation } = await db.from('ajo_reconciliation_log')
      .select('expected_kobo, actual_kobo, variance_kobo').eq('collector_id', c.id).eq('reconciliation_date', today).maybeSingle();

    return {
      collector_id: c.id,
      scheme_id: c.scheme_id,
      scheme_name: c.ajo_schemes?.name || c.scheme_id,
      scheme_type: c.ajo_schemes?.scheme_type || null,
      contribution_amount_kobo: c.ajo_schemes?.contribution_amount_kobo || 0,
      scheme_status: c.ajo_schemes?.status || null,
      reconciled_today: !!todaysReconciliation,
      todays_reconciliation: todaysReconciliation || null,
    };
  }));

  return ok({ assignments });
};
