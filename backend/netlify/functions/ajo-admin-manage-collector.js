/**
 * zillion/backend/netlify/functions/ajo-admin-manage-collector.js
 *
 * POST /api/v1/ajo-admin-manage-collector
 * Body: { scheme_id, zillion_id, action: 'assign' | 'remove' }
 *
 * Only the scheme's own group admin can assign or remove a
 * collector - a collector is someone trusted to record cash on
 * behalf of other members, so this is deliberately not self-service.
 *
 * "remove" sets status INACTIVE rather than deleting the row - the
 * collector's past cash-recording history and reconciliation log
 * stay attributable to them even after they stop collecting.
 *
 * Auth: wallet JWT (zillion_id) - must be the scheme's own admin.
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
  const zillionId = auth.payload.zillion_id;
  if (!zillionId) return err(400, 'No zillion_id on this token — sign in through the wallet first');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const schemeId = (body.scheme_id || '').trim();
  const collectorZillionId = (body.zillion_id || '').trim();
  const action = body.action;

  if (!schemeId) return err(400, 'scheme_id is required');
  if (!collectorZillionId) return err(400, 'zillion_id is required');
  if (!['assign', 'remove'].includes(action)) return err(400, "action must be 'assign' or 'remove'");

  const db = getServiceClient();
  const { data: scheme } = await db.from('ajo_schemes').select('id, created_by_zillion_id').eq('id', schemeId).maybeSingle();
  if (!scheme) return err(404, 'Scheme not found');
  if (scheme.created_by_zillion_id !== zillionId) return err(403, 'Only this scheme\'s own group admin can manage collectors');

  if (action === 'assign') {
    const { data: existing } = await db.from('ajo_collectors').select('id, status').eq('scheme_id', schemeId).eq('zillion_id', collectorZillionId).maybeSingle();
    if (existing) {
      if (existing.status === 'ACTIVE') return err(400, 'This person is already an active collector for this scheme');
      const { data: reactivated, error } = await db.from('ajo_collectors').update({ status: 'ACTIVE' }).eq('id', existing.id).select().single();
      if (error) return err(500, `Failed to reactivate collector: ${error.message}`);
      return ok({ success: true, collector: reactivated });
    }
    const { data: created, error } = await db.from('ajo_collectors').insert({ scheme_id: schemeId, zillion_id: collectorZillionId }).select().single();
    if (error) return err(500, `Failed to assign collector: ${error.message}`);
    return ok({ success: true, collector: created });
  }

  // remove
  const { data: collector } = await db.from('ajo_collectors').select('id').eq('scheme_id', schemeId).eq('zillion_id', collectorZillionId).eq('status', 'ACTIVE').maybeSingle();
  if (!collector) return err(404, 'No active collector found with that zillion_id on this scheme');
  const { data: updated, error } = await db.from('ajo_collectors').update({ status: 'INACTIVE' }).eq('id', collector.id).select().single();
  if (error) return err(500, `Failed to remove collector: ${error.message}`);
  return ok({ success: true, collector: updated });
};
