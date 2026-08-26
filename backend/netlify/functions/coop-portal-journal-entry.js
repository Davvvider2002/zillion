/**
 * zillion/backend/netlify/functions/coop-portal-journal-entry.js
 *
 * GET  /api/v1/coop-portal-journal-entry            — list entries (with lines)
 * POST /api/v1/coop-portal-journal-entry            — create a manual journal entry
 *
 * Every line is entered in its account's own currency; the server
 * looks up that account's currency and the caller's supplied
 * exchange rate (1 for base-currency accounts) to compute each
 * line's base-currency equivalent, then rejects the whole entry
 * unless total debits equal total credits in base currency — the
 * only way a multi-currency entry can be meaningfully required to
 * balance. Entries post immediately; there's no draft/approval
 * workflow in this pass.
 *
 * Body (POST): {
 *   entry_date, description,
 *   lines: [{ account_id, line_type: 'debit'|'credit', amount, exchange_rate?, memo? }]
 * }
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety } = require('../../lib/coopPortalAuth');
const { hasAddon }             = require('../../lib/coopEntitlements');
const { linesAreBalanced }     = require('../../lib/coopAccounting');
const { auditLog }             = require('../../lib/auditLog');
const { recordDuesAccrual }    = require('../../lib/coopDuesAccounting');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');

  const db = getServiceClient();
  const resolved = await resolvePortalSociety(db, auth);
  if (!resolved.ok) return err(resolved.status, resolved.error);
  const coopId = resolved.society.coop_id;

  if (!(await hasAddon(db, coopId, 'accounting'))) return err(403, 'The Accounting & Finance module is not on your current plan');

  if (event.httpMethod === 'GET') {
    await recordDuesAccrual(db, coopId); // on-demand check — doesn't require waiting for the next scheduled run
    const { data: entries, error } = await db.from('coop_journal_entries')
      .select('*, coop_journal_entry_lines(*, coop_chart_of_accounts(account_code, account_name))')
      .eq('coop_id', coopId).order('entry_number', { ascending: false }).limit(200);
    if (error) return err(500, error.message);
    return ok({ entries });
  }

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const entryDate    = (body.entry_date || '').trim();
  const description   = (body.description || '').trim();
  const inputLines       = Array.isArray(body.lines) ? body.lines : [];

  if (!entryDate)     return err(400, 'entry_date is required');
  if (!description)    return err(400, 'description is required');
  if (inputLines.length < 2) return err(400, 'At least two lines are required for a double-entry');

  const accountIds = [...new Set(inputLines.map(l => l.account_id))];
  const { data: accounts } = await db.from('coop_chart_of_accounts').select('id, currency, active').eq('coop_id', coopId).in('id', accountIds);
  const accountMap = new Map((accounts || []).map(a => [a.id, a]));

  const resolvedLines = [];
  for (const l of inputLines) {
    const account = accountMap.get(l.account_id);
    if (!account) return err(400, `Unknown account: ${l.account_id}`);
    if (!account.active) return err(400, 'One of the selected accounts is inactive');
    if (!['debit', 'credit'].includes(l.line_type)) return err(400, 'Each line must be debit or credit');
    const amount = Number.isInteger(l.amount) && l.amount > 0 ? l.amount : null;
    if (!amount) return err(400, 'Each line needs a positive integer amount');
    const exchangeRate = account.currency === resolved.society.base_currency ? 1 : (Number(l.exchange_rate) > 0 ? Number(l.exchange_rate) : null);
    if (!exchangeRate) return err(400, `A positive exchange_rate is required for a non-base-currency line (account currency: ${account.currency})`);
    resolvedLines.push({
      accountId: l.account_id, lineType: l.line_type, amount, currency: account.currency,
      exchangeRate, baseAmount: Math.round(amount * exchangeRate), memo: (l.memo || '').trim() || null,
    });
  }

  if (!linesAreBalanced(resolvedLines)) {
    const totalDebit = resolvedLines.filter(l => l.lineType === 'debit').reduce((s, l) => s + l.baseAmount, 0);
    const totalCredit = resolvedLines.filter(l => l.lineType === 'credit').reduce((s, l) => s + l.baseAmount, 0);
    return err(400, `Entry doesn't balance — debits total ${totalDebit}, credits total ${totalCredit} (in ${resolved.society.base_currency || 'base currency'})`);
  }

  // entry_number: simple per-society running counter
  const { data: lastEntry } = await db.from('coop_journal_entries')
    .select('entry_number').eq('coop_id', coopId).order('entry_number', { ascending: false }).limit(1).maybeSingle();
  const nextNumber = (lastEntry?.entry_number || 0) + 1;

  const { data: entry, error: entryErr } = await db.from('coop_journal_entries').insert({
    coop_id: coopId, entry_number: nextNumber, entry_date: entryDate, description,
    entry_type: 'manual', created_by: `portal:${auth.payload.merchant_id}`,
  }).select().single();
  if (entryErr) return err(500, `Failed to create entry: ${entryErr.message}`);

  const { error: linesErr } = await db.from('coop_journal_entry_lines').insert(
    resolvedLines.map(l => ({
      journal_entry_id: entry.id, coop_id: coopId, account_id: l.accountId, line_type: l.lineType,
      amount: l.amount, currency: l.currency, exchange_rate: l.exchangeRate, base_amount: l.baseAmount, memo: l.memo,
    }))
  );
  if (linesErr) {
    await db.from('coop_journal_entries').delete().eq('id', entry.id); // roll back the header if lines failed
    return err(500, `Failed to save entry lines: ${linesErr.message}`);
  }

  await auditLog(db, {
    action: 'COOP_PORTAL_JOURNAL_ENTRY_CREATED', username: auth.payload.merchant_id, role: 'merchant',
    ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_journal_entry', resourceId: entry.id, requestBody: body, result: 'SUCCESS',
  });

  return ok({ success: true, entry_number: nextNumber, entry_id: entry.id });
};
