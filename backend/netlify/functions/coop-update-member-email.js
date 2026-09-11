/**
 * zillion/backend/netlify/functions/coop-update-member-email.js
 *
 * POST /api/v1/coop-update-member-email
 *
 * Lets a coop member set their own email — needed for loan statement
 * delivery, since coop_members previously had no email field at all
 * (members are phone-based throughout the rest of the system). Only
 * ever updates the caller's own record, resolved from their own JWT,
 * never accepted from the request body.
 *
 * Body: { email }
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT } = require('../../lib/validators');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  const zillionId = auth.payload.zillion_id;
  if (!zillionId) return err(400, 'No zillion_id on this token');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const email = (body.email || '').trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err(400, 'A valid email is required');

  const db = getServiceClient();
  // Updates every coop_members row for this zillion_id, not just one -
  // this is a real, legitimate case (the same person can be an active
  // member of more than one society), and it's the same person's own
  // email regardless of which society's membership record it's on.
  // .maybeSingle() previously errored outright whenever more than one
  // row matched, since it expects at most one.
  const { data: updated, error: updateErr } = await db.from('coop_members')
    .update({ email }).eq('zillion_id', zillionId).select('id, email');

  if (updateErr) return err(500, `Failed to update email: ${updateErr.message}`);
  if (!updated || updated.length === 0) return err(404, 'No coop membership found for this account');

  return ok({ success: true, email: updated[0].email });
};
