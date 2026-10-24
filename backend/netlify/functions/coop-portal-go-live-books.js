/**
 * zillion/backend/netlify/functions/coop-portal-go-live-books.js
 *
 * POST /api/v1/coop-portal-go-live-books
 *
 * The accounting side of a go-live catch-up batch (see lib/coopGoLiveBooks.js).
 *
 * Body: { action: 'accrue_dues', batch_id }   books the year's dues income month by month, dated the month end.
 *                                              Repeat it as often as needed before lock: each run replaces the last.
 *     | { action: 'reconcile',   batch_id }   member sub-ledgers against the control accounts at the cutover date,
 *                                              with the year's income and expenditure. Read only.
 *     | { action: 'accounts',    batch_id? }  the chart of accounts, for choosing codes in the opening balance and
 *                                              society income and expense sheets.
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');
const { hasAddon }             = require('../../lib/coopEntitlements');
const { ensureChartOfAccounts } = require('../../lib/coopAccounting');
const { auditLog }             = require('../../lib/auditLog');
const { postDatedDuesAccrual, reconcileBatch } = require('../../lib/coopGoLiveBooks');

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
  if (!(await requirePortalPermission(db, auth, 'accounting', 'create'))) {
    return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');
  }
  if (!(await hasAddon(db, coopId, 'accounting'))) return err(403, 'The Accounting & Finance module is not on your current plan');

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return err(400, 'Invalid JSON'); }
  const actor = `portal:${auth.payload.merchant_id}`;

  if (body.action === 'accounts') {
    await ensureChartOfAccounts(db, coopId, resolved.society.base_currency || 'NGN');
    const { data } = await db.from('coop_chart_of_accounts').select('account_code, account_name, account_type, sub_type, currency, is_system')
      .eq('coop_id', coopId).eq('active', true).order('account_code');
    return ok({ success: true, accounts: data || [] });
  }

  const { data: batch } = await db.from('coop_migration_batches').select('*').eq('id', String(body.batch_id || '')).maybeSingle();
  if (!batch) return err(404, 'Batch not found.');
  if (batch.coop_id !== coopId) return err(403, 'This batch does not belong to your society.');

  if (body.action === 'accrue_dues') {
    const r = await postDatedDuesAccrual(db, coopId, batch, actor);
    if (!r.ok) return err(409, r.error);
    await auditLog(db, { action: 'COOP_GO_LIVE_DUES_ACCRUED', username: auth.payload.merchant_id, role: 'merchant', ip: event.headers['x-forwarded-for'] || null, resourceType: 'coop_migration_batch', resourceId: batch.id, requestBody: { total_kobo: r.total_kobo, entries: r.entries }, result: 'SUCCESS' });
    return ok({ success: true, ...r });
  }

  if (body.action === 'reconcile') {
    try { return ok({ success: true, ...(await reconcileBatch(db, coopId, batch)) }); }
    catch (e) { return err(500, `Could not reconcile: ${e.message}`); }
  }

  return err(400, "action must be 'accrue_dues', 'reconcile' or 'accounts'");
};
