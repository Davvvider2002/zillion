/**
 * zillion/backend/netlify/functions/coop-portal-bank-statement-group-match.js
 *
 * Matching ONE bank-statement line to SEVERAL recorded entries (see lib/coopBankGroupMatch.js for the safeguards).
 *
 * GET  /api/v1/coop-portal-bank-statement-group-match?statement_line_id=<uuid>
 *        the records that could be part of a group for that bank line (nearest first), and any combinations that add up exactly
 * POST { action: 'confirm', statement_line_id, components: [{ type, id }, ...] }   match the line to those records (must add up exactly)
 * POST { action: 'unmatch', statement_line_id }                                    undo a group match
 *
 * Same access as the rest of Bank Reconciliation: the add-on, and the 'reconciliation' permission ('create' to change anything).
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');
const { hasAddon }         = require('../../lib/coopEntitlements');
const { auditLog }         = require('../../lib/auditLog');
const G = require('../../lib/coopBankGroupMatch');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (!['GET', 'POST'].includes(event.httpMethod)) return err(405, 'Method Not Allowed');
  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');

  const db = getServiceClient();
  const resolved = await resolvePortalSociety(db, auth);
  if (!resolved.ok) return err(resolved.status, resolved.error);
  const coopId = resolved.society.coop_id;

  const writing = event.httpMethod === 'POST';
  if (!(await requirePortalPermission(db, auth, 'reconciliation', writing ? 'create' : undefined))) return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');
  if (!(await hasAddon(db, coopId, 'bank_reconciliation'))) return err(403, 'Bank Reconciliation is not on your current plan');
  const actor = { id: String(auth.payload.merchant_id || auth.payload.username || 'unknown'), role: auth.payload.role || 'merchant' };

  try {
    if (!writing) {
      const lineId = (event.queryStringParameters || {}).statement_line_id;
      if (!lineId || !UUID.test(lineId)) return err(400, 'statement_line_id is required');
      const ctx = await G.loadLineContext(db, coopId, lineId);
      if (!ctx) return err(404, 'Statement line not found in your society');
      if (ctx.line.match_status !== 'unmatched') return err(409, 'This bank line is already matched');
      const candidates = await G.loadGroupCandidates(db, coopId, ctx);
      const suggestions = G.suggestGroups(ctx.line.amount_kobo, candidates);
      return ok({
        line: { id: ctx.line.id, date: ctx.line.statement_date, description: ctx.line.description, amount_kobo: ctx.line.amount_kobo, direction: ctx.line.direction },
        bank_account: ctx.account ? { code: ctx.account.account_code, name: ctx.account.account_name } : null,
        candidates: candidates.slice(0, 200).map(c => ({ type: c.type, id: c.id, date: c.date, amount_kobo: c.amountKobo, description: c.description })),
        suggestions,
      });
    }

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return err(400, 'Invalid JSON'); }
    if (!body.statement_line_id || !UUID.test(String(body.statement_line_id))) return err(400, 'statement_line_id is required');

    if (body.action === 'confirm') {
      const r = await G.confirmGroup(db, actor, { coopId, lineId: body.statement_line_id, components: body.components });
      if (r.ok === false) return err(r.status, r.error);
      await auditLog(db, { action: 'COOP_BANK_STATEMENT_GROUP_MATCHED', username: actor.id, role: actor.role, ip: event.headers['x-forwarded-for'] || null,
        resourceType: 'coop_bank_statement_line', resourceId: r.line_id, requestBody: { total_kobo: r.total_kobo, components: r.components.map(c => ({ type: c.type, id: c.id, amount_kobo: c.amount_kobo })) }, result: 'SUCCESS' });
      return ok({ success: true, ...r });
    }
    if (body.action === 'unmatch') {
      const r = await G.unmatchGroup(db, actor, { coopId, lineId: body.statement_line_id });
      if (r.ok === false) return err(r.status, r.error);
      await auditLog(db, { action: 'COOP_BANK_STATEMENT_GROUP_UNMATCHED', username: actor.id, role: actor.role, ip: event.headers['x-forwarded-for'] || null,
        resourceType: 'coop_bank_statement_line', resourceId: r.line_id, requestBody: { released: r.released }, result: 'SUCCESS' });
      return ok({ success: true, ...r });
    }
    return err(400, 'Unknown action');
  } catch (e) {
    return err(500, `Group match failed: ${e.message}`);
  }
};
