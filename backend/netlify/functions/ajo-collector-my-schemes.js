/**
 * zillion/backend/netlify/functions/ajo-collector-my-schemes.js
 *
 * GET /api/v1/ajo-collector-my-schemes
 *
 * Lists every scheme the caller's zillion_id is currently an ACTIVE
 * or PENDING_ESCROW collector for - the missing piece that made the
 * entire collector feature invisible: ajo-collector-record-cash.js
 * and ajo-collector-reconcile.js have existed since early in this
 * build, but nothing ever let a collector discover which schemes
 * they were even assigned to in the first place.
 *
 * PENDING_ESCROW is included, not just ACTIVE - excluding it would
 * mean someone freshly assigned as a collector, who has not yet
 * verified their escrow wallet, could never even discover this
 * screen to start that verification. That's the single most
 * important state to surface, since it's the very first step in
 * actually onboarding a collector.
 *
 * Also returns the caller's own collector_profile (escrow_status,
 * compliance_score, delisted_at) once, at the top level - every
 * scheme assignment shares the same person's profile, so this is
 * fetched once rather than duplicated per assignment.
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
  if (!zillionId) return ok({ assignments: [], collector_profile: null });

  const db = getServiceClient();

  const { data: profile } = await db.from('ajo_collector_profiles')
    .select('id, escrow_status, escrow_account_number, escrow_account_name, escrow_rejection_reason, compliance_score, delisted_at, delisted_reason')
    .eq('zillion_id', zillionId).maybeSingle();

  const { data: collectorRows } = await db.from('ajo_collectors')
    .select('id, scheme_id, status, assigned_at, ajo_schemes(name, scheme_type, contribution_amount_kobo, status)')
    .eq('zillion_id', zillionId).in('status', ['ACTIVE', 'PENDING_ESCROW']);

  const assignments = await Promise.all((collectorRows || []).map(async (c) => {
    let reconciled_today = false, todays_reconciliation = null;
    if (c.status === 'ACTIVE') {
      const today = new Date().toISOString().slice(0, 10);
      const { data: todaysReconciliation } = await db.from('ajo_reconciliation_log')
        .select('expected_kobo, actual_kobo, variance_kobo').eq('collector_id', c.id).eq('reconciliation_date', today).maybeSingle();
      reconciled_today = !!todaysReconciliation;
      todays_reconciliation = todaysReconciliation || null;
    }

    return {
      collector_id: c.id,
      status: c.status,
      scheme_id: c.scheme_id,
      scheme_name: c.ajo_schemes?.name || c.scheme_id,
      scheme_type: c.ajo_schemes?.scheme_type || null,
      contribution_amount_kobo: c.ajo_schemes?.contribution_amount_kobo || 0,
      scheme_status: c.ajo_schemes?.status || null,
      reconciled_today,
      todays_reconciliation,
    };
  }));

  return ok({ assignments, collector_profile: profile || null });
};
