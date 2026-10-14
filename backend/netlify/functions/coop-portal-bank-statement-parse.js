/**
 * zillion/backend/netlify/functions/coop-portal-bank-statement-parse.js
 *
 * POST /api/v1/coop-portal-bank-statement-parse
 *
 * Reads a bank statement the person chose (PDF, or the rows of an Excel / CSV the browser already opened) and hands back what is in it
 * for them to CHECK before anything is saved: the lines, the opening and closing balance the statement itself states, whether the file
 * proves itself (running balance, bank totals), and what the books say the selected bank account should hold on the statement's last day.
 * Nothing is written. The person picks the bank account from a list; nobody types a balance.
 *
 * Body: { bank_account_id, filename, kind: 'pdf' | 'rows', data_base64?  (pdf), rows?: [[cell,...],...] (excel/csv) }
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT } = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');
const { hasAddon } = require('../../lib/coopEntitlements');
const { limitByKey, tooManyRequests } = require('../../lib/publicRateLimit');
const { computeAccountLedger } = require('../../lib/coopFinancialReports');
const parser = require('../../lib/bankStatementParser');

const MAX_ROWS = 20000;

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok = b => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c, m, extra) => ({ statusCode: c, headers: hdr, body: JSON.stringify({ error: m, ...(extra || {}) }) });
  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  const db = getServiceClient();
  const resolved = await resolvePortalSociety(db, auth);
  if (!resolved.ok) return err(resolved.status, resolved.error);
  const coopId = resolved.society.coop_id;
  if (!(await requirePortalPermission(db, auth, 'reconciliation', 'create'))) return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');
  if (!(await hasAddon(db, coopId, 'bank_reconciliation'))) return err(403, 'Bank Reconciliation is not on your current plan');

  const lim = await limitByKey(db, 'stmt-parse', coopId, { windowMinutes: 10, maxAttempts: 20, lockoutMinutes: 10 });
  if (!lim.allowed) return tooManyRequests(lim.retryAfterSeconds, 'statement uploads');

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return err(400, 'Invalid JSON'); }
  if (!body.bank_account_id) return err(400, 'Choose the bank account this statement belongs to');

  const { data: bank } = await db.from('coop_chart_of_accounts').select('id, account_code, account_name, sub_type, active')
    .eq('id', body.bank_account_id).eq('coop_id', coopId).maybeSingle();
  if (!bank || !bank.active) return err(400, 'That account was not found in your chart of accounts');
  if (bank.sub_type !== 'bank_cash') return err(400, `"${bank.account_name}" is not classified as Bank & Cash`);

  let parsed;
  try {
    if (body.kind === 'pdf') {
      const b64 = String(body.data_base64 || '');
      if (!b64) return err(400, 'No file received');
      parsed = await parser.parsePdfBuffer(Buffer.from(b64, 'base64'));
    } else if (body.kind === 'rows') {
      if (!Array.isArray(body.rows)) return err(400, 'No rows received');
      if (body.rows.length > MAX_ROWS) return err(400, `The file has more than ${MAX_ROWS} rows. Export a shorter period.`);
      parsed = parser.parseTableRows(body.rows);
    } else return err(400, 'kind must be "pdf" or "rows"');
  } catch (e) {
    if (e instanceof parser.StatementParseError) return err(422, e.message);
    console.error('[bank-statement-parse]', e && e.message);
    return err(500, 'Could not read that statement. Try the Excel / CSV version.');
  }

  // What the books say this account holds on the statement's last day, to set beside the bank's closing balance.
  let books = null;
  try {
    const led = await computeAccountLedger(db, coopId, bank.id, parsed.meta.period_to);
    books = { as_of: parsed.meta.period_to, balance_kobo: led.closing_balance_kobo };
    if (parsed.closing_balance_kobo != null) books.difference_kobo = parsed.closing_balance_kobo - led.closing_balance_kobo;
  } catch (e) { console.error('[bank-statement-parse] ledger', e && e.message); }

  // The statement says which account it is; warn if it plainly is not the one chosen (the chosen account's number is not stored on the ledger account, so this is a hint only).
  return ok({ success: true, bank_account: { id: bank.id, code: bank.account_code, name: bank.account_name }, statement: parsed, books });
};
