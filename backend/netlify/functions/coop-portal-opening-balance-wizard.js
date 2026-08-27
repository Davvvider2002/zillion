/**
 * zillion/backend/netlify/functions/coop-portal-opening-balance-wizard.js
 *
 * POST /api/v1/coop-portal-opening-balance-wizard
 *
 * Takes a plain list of "this account currently has this much" from
 * the society and turns it into one real, balanced journal entry —
 * the person doesn't need to work out which side of a debit/credit
 * their opening cash balance goes on. Whatever doesn't naturally
 * balance (e.g. they only know their cash balance, not the other
 * side) is absorbed into Opening Balance Equity, the standard
 * accounting convention for this exact situation.
 *
 * Can only be run once per society — opening balances are a one-time
 * setup step, not a recurring action.
 *
 * Body: {
 *   opening_date,
 *   balances: [{ account_id, amount, exchange_rate? }]
 * }
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety } = require('../../lib/coopPortalAuth');
const { hasAddon }             = require('../../lib/coopEntitlements');
const { ensureChartOfAccounts, buildOpeningBalanceLines, linesAreBalanced } = require('../../lib/coopAccounting');
const { auditLog }             = require('../../lib/auditLog');

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
  const baseCurrency = resolved.society.base_currency || 'NGN';

  if (!(await hasAddon(db, coopId, 'accounting'))) return err(403, 'The Accounting & Finance module is not on your current plan');

  const { data: alreadyRun } = await db.from('coop_journal_entries').select('id').eq('coop_id', coopId).eq('entry_type', 'opening_balance').maybeSingle();
  if (alreadyRun) return err(409, 'Opening balances have already been set for this society. Use a normal journal entry to make adjustments.');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const openingDate = (body.opening_date || '').trim();
  const inputBalances = Array.isArray(body.balances) ? body.balances.filter(b => Number.isInteger(b.amount) && b.amount > 0) : [];
  if (!openingDate) return err(400, 'opening_date is required');
  if (!inputBalances.length) return err(400, 'At least one account balance is required');

  await ensureChartOfAccounts(db, coopId, baseCurrency);

  const accountIds = inputBalances.map(b => b.account_id);
  const { data: accounts } = await db.from('coop_chart_of_accounts').select('id, account_type, currency, is_system').eq('coop_id', coopId).in('id', accountIds);
  const accountMap = new Map((accounts || []).map(a => [a.id, a]));

  const { data: obeAccount } = await db.from('coop_chart_of_accounts').select('id').eq('coop_id', coopId).eq('account_code', '3900').single();
  if (!obeAccount) return err(500, 'Opening Balance Equity account is missing — contact support');

  const resolvedBalances = [];
  for (const b of inputBalances) {
    const account = accountMap.get(b.account_id);
    if (!account) return err(400, `Unknown account: ${b.account_id}`);
    if (account.is_system) return err(400, 'Cannot set an opening balance directly on a system account');
    const exchangeRate = account.currency === baseCurrency ? 1 : (Number(b.exchange_rate) > 0 ? Number(b.exchange_rate) : null);
    if (!exchangeRate) return err(400, `A positive exchange_rate is required for a non-base-currency account (currency: ${account.currency})`);
    resolvedBalances.push({ accountId: b.account_id, accountType: account.account_type, amount: b.amount, currency: account.currency, exchangeRate });
  }

  const lines = buildOpeningBalanceLines(resolvedBalances, obeAccount.id);
  if (!linesAreBalanced(lines)) return err(500, 'Internal error: opening balance lines did not balance — contact support before proceeding');

  const { data: lastEntry } = await db.from('coop_journal_entries')
    .select('entry_number').eq('coop_id', coopId).order('entry_number', { ascending: false }).limit(1).maybeSingle();
  const nextNumber = (lastEntry?.entry_number || 0) + 1;

  const { data: entry, error: entryErr } = await db.from('coop_journal_entries').insert({
    coop_id: coopId, entry_number: nextNumber, entry_date: openingDate, description: 'Opening balances',
    entry_type: 'opening_balance', created_by: `portal:${auth.payload.merchant_id}`,
  }).select().single();
  if (entryErr) return err(500, `Failed to create opening balance entry: ${entryErr.message}`);

  const { error: linesErr } = await db.from('coop_journal_entry_lines').insert(
    lines.map(l => ({
      journal_entry_id: entry.id, coop_id: coopId, account_id: l.accountId, line_type: l.lineType,
      amount: l.amount, currency: l.currency, exchange_rate: l.exchangeRate, base_amount: l.baseAmount,
      memo: l.accountId === obeAccount.id ? 'Opening balance offset' : null,
    }))
  );
  if (linesErr) {
    await db.from('coop_journal_entries').delete().eq('id', entry.id);
    return err(500, `Failed to save opening balance lines: ${linesErr.message}`);
  }

  await auditLog(db, {
    action: 'COOP_PORTAL_OPENING_BALANCE_SET', username: auth.payload.merchant_id, role: 'merchant',
    ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_journal_entry', resourceId: entry.id, requestBody: body, result: 'SUCCESS',
  });

  return ok({ success: true, entry_id: entry.id, lines_created: lines.length });
};
