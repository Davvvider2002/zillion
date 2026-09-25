/**
 * zillion/backend/netlify/functions/ajo-admin-manage-collector.js
 *
 * POST /api/v1/ajo-admin-manage-collector
 *
 * DEPRECATED as of the group-admin/collector role merge. A group
 * scheme's admin and collector are now the same person by design,
 * not two entities that happen to coincide - assigned automatically
 * the moment a scheme is created (ajo-admin-create-scheme.js), not
 * as a separate action naming someone else. Personal savings never
 * used this endpoint either - its collector is chosen at creation
 * time (ajo-collector-directory.js + collector_profile_id).
 *
 * That leaves no legitimate case this endpoint still serves, so both
 * actions now return a clear explanation rather than either quietly
 * still working (which would contradict the merged model) or
 * returning a bare 404 (which would look like a bug rather than a
 * deliberate design decision).
 *
 * Deliberately NOT deleted outright - anything still calling this
 * (an old cached frontend build, a stray integration) gets a
 * meaningful error explaining what changed, not a broken request.
 *
 * Transferring an existing scheme's admin/collector role to a
 * different person - if that's ever genuinely needed (the founding
 * admin stepping down, a compromised account, etc.) - is a separate,
 * more sensitive operation than what this endpoint used to do, and
 * isn't covered here. That would need its own deliberate design, not
 * a reuse of the old assign/remove logic.
 */
'use strict';

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const err = (c,m) => ({ statusCode: c, headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  return err(410, "A group's admin and collector are now the same role, assigned automatically when the scheme is created - there's no separate step to assign or remove a collector. If you need to change who administers an existing scheme, contact support rather than using this endpoint.");
};
