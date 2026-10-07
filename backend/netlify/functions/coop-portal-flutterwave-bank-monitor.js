/**
 * zillion/backend/netlify/functions/coop-portal-flutterwave-bank-monitor.js
 *
 * GET /api/v1/coop-portal-flutterwave-bank-monitor?from=YYYY-MM-DD&to=YYYY-MM-DD[&account_code=1010]
 *
 * The society's bank account as Flutterwave money moves through it: which real account it is, what moved in and out, and whether
 * every Flutterwave settlement and Zillion payout actually reached the bank statements the society has uploaded.
 * See lib/coopFlutterwaveBankMonitor.js. Same access as the rest of Bank Reconciliation (the add-on, and the 'reconciliation' permission).
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');
const { hasAddon }         = require('../../lib/coopEntitlements');
const { buildBankMonitor } = require('../../lib/coopFlutterwaveBankMonitor');

const DATE = /^\d{4}-\d{2}-\d{2}$/;

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

  if (!(await requirePortalPermission(db, auth, 'reconciliation'))) return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');
  if (!(await hasAddon(db, coopId, 'bank_reconciliation'))) return err(403, 'Bank Reconciliation is not on your current plan');

  const q = event.queryStringParameters || {};
  if ((q.from && !DATE.test(q.from)) || (q.to && !DATE.test(q.to))) return err(400, 'from and to must be dates like 2026-10-01');
  if (q.from && q.to && q.from > q.to) return err(400, 'from must not be after to');
  if (q.account_code && !/^[A-Za-z0-9_-]{1,20}$/.test(q.account_code)) return err(400, 'Invalid account_code');

  try {
    return ok(await buildBankMonitor(db, coopId, { from: q.from, to: q.to, accountCode: q.account_code }));
  } catch (e) {
    return err(500, `Bank account monitor failed: ${e.message}`);
  }
};
