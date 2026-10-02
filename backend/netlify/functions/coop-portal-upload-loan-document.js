/**
 * zillion/backend/netlify/functions/coop-portal-upload-loan-document.js
 *
 * POST /api/v1/coop-portal-upload-loan-document
 * Body: { file_base64, file_name, mime_type? }
 *
 * Uploads the supporting document for a loan qualification override (a signed approval letter, board
 * minutes, whatever backs up the decision) to a private storage bucket, and returns the storage path for
 * coop-portal-create-loan.js's override.document_storage_path. A standalone step rather than accepting the
 * file inline on the create-loan call itself, because Netlify's synchronous function payload limit (~6MB)
 * sits uncomfortably close to real scanned-document sizes - this endpoint alone carries that risk, not the
 * loan-creation path, and a failed upload never leaves a half-created loan behind.
 *
 * Requires 'loans'/'override' - the same separately-grantable permission the override itself requires, not
 * the general 'loans'/'create' - uploading a backup document for an override is itself part of exercising
 * that specific right.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');

const MAX_BYTES = 10 * 1024 * 1024; // matches the bucket's own file_size_limit
const ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');

  const db = getServiceClient();
  const resolved = await resolvePortalSociety(db, auth);
  if (!resolved.ok) return err(resolved.status, resolved.error);
  const coopId = resolved.society.coop_id;

  if (!(await requirePortalPermission(db, auth, 'loans', 'override'))) {
    return err(403, 'You do not have the loan override permission. Ask your society admin to grant it.');
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const fileName = (body.file_name || '').trim();
  const mimeType = (body.mime_type || '').trim() || 'application/octet-stream';
  const b64 = (body.file_base64 || '').trim();

  if (!fileName) return err(400, 'file_name is required');
  if (!b64) return err(400, 'file_base64 is required');
  if (!ALLOWED_MIME.includes(mimeType)) return err(400, `File type must be one of: PDF, JPEG, PNG, WEBP`);

  let buffer;
  try { buffer = Buffer.from(b64, 'base64'); }
  catch { return err(400, 'file_base64 is not valid base64'); }

  if (buffer.length === 0) return err(400, 'The uploaded file is empty');
  if (buffer.length > MAX_BYTES) return err(400, `File is too large — max ${(MAX_BYTES / 1024 / 1024).toFixed(0)}MB`);

  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100);
  const storagePath = `${coopId}/${Date.now()}-${safeName}`;

  const { error: uploadErr } = await db.storage.from('loan-override-documents')
    .upload(storagePath, buffer, { contentType: mimeType, upsert: false });
  if (uploadErr) return err(500, `Failed to upload document: ${uploadErr.message}`);

  return ok({ success: true, document_storage_path: storagePath, document_file_name: fileName, document_mime_type: mimeType });
};
