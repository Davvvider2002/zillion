/**
 * zillion/backend/netlify/functions/coop-portal-loan-override-document.js
 *
 * GET /api/v1/coop-portal-loan-override-document?loan_id=...
 *
 * Returns a short-lived signed URL for the supporting document attached to a loan's qualification override
 * (see coop-portal-upload-loan-document.js / coop-portal-create-loan.js) — the whole point of keeping it as
 * "backup" is that it stays retrievable later, not just at the moment it was uploaded. The bucket is private,
 * so this is the only way to actually open the file.
 *
 * Gated at 'loans'/'view' (not 'loans'/'override') - anyone who can see a loan at all should be able to see
 * why it was overridden and check the evidence; only CREATING an override needs the stronger permission.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');

  const db = getServiceClient();
  const resolved = await resolvePortalSociety(db, auth);
  if (!resolved.ok) return err(resolved.status, resolved.error);
  const coopId = resolved.society.coop_id;

  if (!(await requirePortalPermission(db, auth, 'loans', 'view'))) {
    return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');
  }

  const loanId = (event.queryStringParameters || {}).loan_id;
  if (!loanId) return err(400, 'loan_id is required');

  const { data: overrides } = await db.from('coop_loan_overrides')
    .select('*').eq('loan_id', loanId).eq('coop_id', coopId).order('created_at', { ascending: false });
  if (!overrides || !overrides.length) return err(404, 'No override found for this loan');

  const latest = overrides[0];
  const { data: signed, error: signErr } = await db.storage.from('loan-override-documents')
    .createSignedUrl(latest.document_storage_path, 120, { download: latest.document_file_name });
  if (signErr) return err(500, `Failed to generate a link to the document: ${signErr.message}`);

  return ok({
    overrides: overrides.map(o => ({
      bypassed_checks: o.bypassed_checks, reason: o.reason, approved_by: o.approved_by,
      document_file_name: o.document_file_name, created_at: o.created_at,
    })),
    document_url: signed.signedUrl,
  });
};
