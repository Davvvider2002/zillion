/**
 * zillion/backend/netlify/functions/coop-send-loan-statement.js
 *
 * POST /api/v1/coop-send-loan-statement
 *
 * Generates a member's loan statement PDF and emails it. Two ways in:
 *  - A member's own wallet JWT (zillion_id) — sends their own statement.
 *  - A society admin's portal JWT (merchant_id) — body must include
 *    member_id, and that member must belong to the admin's own
 *    society (checked explicitly, never trusted from the client).
 *
 * If tried without an email on file, fails clearly rather than
 * silently doing nothing — the member (or admin, on their behalf)
 * needs to know an email needs to be added first.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT } = require('../../lib/validators');
const { resolvePortalSociety } = require('../../lib/coopPortalAuth');
const { computeMemberLoanStatement } = require('../../lib/coopLoanStatement');
const { generateLoanStatementPdf } = require('../../lib/coopLoanStatementPdf');
const { sendEmail } = require('../../lib/resendEmail');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');

  const db = getServiceClient();

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { /* empty body is fine for the member self-request path */ }

  let memberId;
  if (auth.payload.zillion_id) {
    // Member requesting their own statement.
    const { data: member } = await db.from('coop_members').select('id').eq('zillion_id', auth.payload.zillion_id).maybeSingle();
    if (!member) return err(404, 'No coop membership found for this account');
    memberId = member.id;
  } else if (auth.payload.merchant_id) {
    // Admin requesting on a member's behalf — verified against their
    // own resolved society, never trusted blindly from the client.
    if (!body.member_id) return err(400, 'member_id is required');
    const resolved = await resolvePortalSociety(db, auth);
    if (!resolved.ok) return err(resolved.status, resolved.error);
    const { data: member } = await db.from('coop_members').select('id, coop_id').eq('id', body.member_id).maybeSingle();
    if (!member || member.coop_id !== resolved.society.coop_id) return err(404, 'Member not found in your society');
    memberId = member.id;
  } else {
    return err(401, 'Token does not carry a recognized identity');
  }

  const statementData = await computeMemberLoanStatement(db, memberId);
  if (!statementData) return err(404, 'Member not found');
  if (!statementData.member.email) return err(400, 'No email on file for this member — add one before requesting a statement');

  let pdfBuffer;
  try {
    pdfBuffer = await generateLoanStatementPdf(statementData);
  } catch (e) {
    return err(500, `Failed to generate statement PDF: ${e.message}`);
  }

  const result = await sendEmail({
    to: statementData.member.email,
    toName: statementData.member.name,
    subject: `Your Zillion Coop loan statement — ${statementData.member.society_name}`,
    htmlContent: `<p>Hi ${statementData.member.name},</p><p>Your loan statement is attached.</p>`,
    attachments: [{ filename: 'loan-statement.pdf', content: pdfBuffer.toString('base64') }],
  });

  if (!result.sent) return err(502, `Statement generated but email failed to send: ${result.reason}`);

  return ok({ success: true, sent_to: statementData.member.email });
};
