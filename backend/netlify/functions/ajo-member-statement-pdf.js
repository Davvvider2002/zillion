/**
 * zillion/backend/netlify/functions/ajo-member-statement-pdf.js
 *
 * GET /api/v1/ajo-member-statement-pdf?scheme_id=X
 *
 * A member's own contribution statement for one scheme, as a base64
 * PDF - mirrors coop-portal-reconciliation-statement-pdf.js's
 * response pattern exactly (JSON with a base64 pdf_base64 field, not
 * a raw binary response), for consistency with the one other
 * PDF-download endpoint in this codebase.
 *
 * Always the caller's own scheme_member_id for this scheme, never
 * another member's - same scoping as
 * ajo-member-contribution-history.js, whose exact query this reuses,
 * so the two views (in-app list and downloadable statement) can never
 * silently show different numbers.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { generateAjoStatementPdf } = require('../../lib/ajoStatementPdf');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  const zillionId = auth.payload.zillion_id;
  if (!zillionId) return err(400, 'No zillion_id on this token — sign in through the wallet first');

  const schemeId = (event.queryStringParameters || {}).scheme_id;
  if (!schemeId) return err(400, 'scheme_id query parameter is required');

  const db = getServiceClient();

  const { data: scheme } = await db.from('ajo_schemes')
    .select('id, name, scheme_type, contribution_amount_kobo, frequency').eq('id', schemeId).maybeSingle();
  if (!scheme) return err(404, 'Scheme not found');

  const { data: member } = await db.from('ajo_scheme_members').select('id').eq('scheme_id', schemeId).eq('zillion_id', zillionId).maybeSingle();
  if (!member) return err(404, 'You are not a member of this scheme');

  const { data: identity } = await db.from('zillion_identities').select('phone_normalized').eq('zillion_id', zillionId).maybeSingle();

  const { data: contributions } = await db.from('ajo_contributions')
    .select('amount_kobo, source, diverted_to_collector, created_at')
    .eq('scheme_member_id', member.id).order('created_at', { ascending: false }).limit(200);

  const rows = contributions || [];
  const totalOwnKobo = rows.filter(c => !c.diverted_to_collector).reduce((s, c) => s + c.amount_kobo, 0);
  const totalDivertedKobo = rows.filter(c => c.diverted_to_collector).reduce((s, c) => s + c.amount_kobo, 0);

  const pdfBuffer = await generateAjoStatementPdf({
    scheme, member: { phone_normalized: identity?.phone_normalized || null },
    contributions: rows, totalOwnKobo, totalDivertedKobo,
  });

  return ok({
    success: true,
    filename: `ajo-statement-${scheme.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.pdf`,
    pdf_base64: pdfBuffer.toString('base64'),
  });
};
