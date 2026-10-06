/**
 * zillion/backend/netlify/functions/coop-portal-flutterwave-ledger.js
 *
 * GET  /api/v1/coop-portal-flutterwave-ledger?live=1&from=YYYY-MM-DD&to=YYYY-MM-DD[&format=csv]
 *      The society's Flutterwave ledger: every payment collected (IN), every settlement paid to the bank (OUT), the Dr/Cr
 *      journal lines behind each, a running balance (= what Flutterwave still holds for the society) and the matching
 *      checks. live=1 (default) shows live payments only; live=0 includes test-mode payments, clearly marked.
 *
 * POST { action: 'set_settlement_account', account_code }   choose which of the society's bank accounts Flutterwave settles into
 * POST { action: 'sync_settlements' }                        pull settlements from Flutterwave now and book/match them
 *
 * Reading needs 'accounting'/'view'; changing the settlement account or syncing needs 'accounting'/'edit'.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');
const { buildLedgerReport, ledgerToCsv, setSettlementAccount, syncSettlements } = require('../../lib/coopFlutterwaveLedger');

const DATE = /^\d{4}-\d{2}-\d{2}$/;

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

  try {
    if (event.httpMethod === 'GET') {
      if (!(await requirePortalPermission(db, auth, 'accounting', 'view'))) return err(403, 'You do not have access to Accounting. Ask your society admin to grant it.');
      const q = event.queryStringParameters || {};
      if ((q.from && !DATE.test(q.from)) || (q.to && !DATE.test(q.to))) return err(400, 'from and to must be dates like 2026-10-01');
      const report = await buildLedgerReport(db, coopId, { liveOnly: q.live !== '0', from: q.from, to: q.to });
      if (q.format === 'csv') {
        return { statusCode: 200, headers: { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="flutterwave-ledger-${coopId}.csv"` }, body: ledgerToCsv(report) };
      }
      return ok(report);
    }

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return err(400, 'Invalid JSON'); }
    if (!(await requirePortalPermission(db, auth, 'accounting', 'edit'))) return err(403, 'You do not have permission to change Accounting settings. Ask your society admin to grant it.');

    if (body.action === 'set_settlement_account') {
      const r = await setSettlementAccount(db, coopId, String(body.account_code || '').trim());
      return r.ok ? ok({ success: true, account_code: r.account_code, account_name: r.account_name }) : err(400, r.error);
    }
    if (body.action === 'sync_settlements') {
      const { data: society } = await db.from('coop_societies').select('coop_id, name, flutterwave_subaccount_id, settlement_account_code, settlement_account_name, settlement_account_number').eq('coop_id', coopId).maybeSingle();
      const result = await syncSettlements(db, society);
      if (result.skipped) return ok({ success: true, skipped: result.skipped });
      return ok({ success: result.errors.length === 0, ...result });
    }
    return err(400, 'Unknown action');
  } catch (e) {
    return err(500, `Flutterwave ledger failed: ${e.message}`);
  }
};
