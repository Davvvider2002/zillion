/**
 * zillion/backend/netlify/functions/coop-portal-chart-of-accounts.js
 *
 * GET  /api/v1/coop-portal-chart-of-accounts   — list (auto-seeds defaults on first call)
 * POST /api/v1/coop-portal-chart-of-accounts   — create a custom account
 *
 * Gated behind the Accounting add-on — the first real feature gate in
 * the system, using the entitlements foundation built earlier.
 *
 * Body (POST): { account_code, account_name, account_type, sub_type?, currency?,
 *                opening_balance?, opening_balance_side? ('debit'|'credit') }
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');
const { hasAddon }             = require('../../lib/coopEntitlements');
const { ACCOUNT_TYPES, SUB_TYPES, ensureChartOfAccounts } = require('../../lib/coopAccounting');
const { auditLog }             = require('../../lib/auditLog');

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

  if (!(await requirePortalPermission(db, auth, 'accounting'))) {
    return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');
  }

  if (!(await hasAddon(db, coopId, 'accounting'))) return err(403, 'The Accounting & Finance module is not on your current plan');

  const baseCurrency = resolved.society.base_currency || 'NGN';

  if (event.httpMethod === 'GET') {
    await ensureChartOfAccounts(db, coopId, baseCurrency);
    const { data: accounts, error } = await db.from('coop_chart_of_accounts')
      .select('*').eq('coop_id', coopId).eq('active', true).order('account_code');
    if (error) return err(500, error.message);
    return ok({ accounts, base_currency: baseCurrency, sub_types: SUB_TYPES });
  }

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const code     = (body.account_code || '').trim();
  const name     = (body.account_name || '').trim();
  const type     = body.account_type;
  const subType  = (body.sub_type || '').trim() || null;
  const currency = (body.currency || baseCurrency).trim().toUpperCase();

  if (!code) return err(400, 'account_code is required');
  if (!name) return err(400, 'account_name is required');
  if (!ACCOUNT_TYPES.includes(type)) return err(400, `account_type must be one of: ${ACCOUNT_TYPES.join(', ')}`);
  if (subType && !SUB_TYPES[type].some(s => s.key === subType)) {
    return err(400, `sub_type "${subType}" is not valid for account_type ${type}. Valid options: ${SUB_TYPES[type].map(s => s.key).join(', ')}`);
  }

  const hasOpeningBalance = body.opening_balance != null;
  let openingBalanceKobo = null;
  if (hasOpeningBalance) {
    openingBalanceKobo = Math.round(Number(body.opening_balance) * 100);
    if (!Number.isFinite(openingBalanceKobo) || openingBalanceKobo <= 0) return err(400, 'opening_balance must be a positive number');
    if (!['debit', 'credit'].includes(body.opening_balance_side)) return err(400, 'opening_balance_side must be "debit" or "credit" when opening_balance is given');
  }

  const { data: created, error: insertErr } = await db.from('coop_chart_of_accounts').insert({
    coop_id: coopId, account_code: code, account_name: name, account_type: type, sub_type: subType, currency,
  }).select().single();
  if (insertErr) return err(insertErr.code === '23505' ? 409 : 500, insertErr.code === '23505' ? `Account code ${code} is already in use` : insertErr.message);

  let openingEntryId = null;
  if (hasOpeningBalance) {
    // Same convention as the opening-balance wizard: offset against
    // Opening Balance Equity (3900) so a single-account opening
    // balance is still a real, balanced double-entry, not a special
    // case bypassing the ledger.
    const { data: obeAccount } = await db.from('coop_chart_of_accounts').select('id').eq('coop_id', coopId).eq('account_code', '3900').maybeSingle();
    if (obeAccount) {
      const { data: lastEntry } = await db.from('coop_journal_entries')
        .select('entry_number').eq('coop_id', coopId).order('entry_number', { ascending: false }).limit(1).maybeSingle();
      const nextNumber = (lastEntry?.entry_number || 0) + 1;

      const { data: entry } = await db.from('coop_journal_entries').insert({
        coop_id: coopId, entry_number: nextNumber, entry_date: new Date().toISOString().slice(0, 10),
        description: `Opening balance — ${name}`, entry_type: 'manual', created_by: `portal:${auth.payload.merchant_id}`,
      }).select().single();

      if (entry) {
        const offsetSide = body.opening_balance_side === 'debit' ? 'credit' : 'debit';
        await db.from('coop_journal_entry_lines').insert([
          { journal_entry_id: entry.id, coop_id: coopId, account_id: created.id, line_type: body.opening_balance_side, amount: openingBalanceKobo, currency, exchange_rate: 1, base_amount: openingBalanceKobo },
          { journal_entry_id: entry.id, coop_id: coopId, account_id: obeAccount.id, line_type: offsetSide, amount: openingBalanceKobo, currency: 'base', exchange_rate: 1, base_amount: openingBalanceKobo, memo: 'Opening balance offset' },
        ]);
        openingEntryId = entry.id;
      }
    }
  }

  await auditLog(db, {
    action: 'COOP_PORTAL_ACCOUNT_CREATED', username: auth.payload.merchant_id, role: 'merchant',
    ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_chart_of_accounts', resourceId: created.id, requestBody: body, result: 'SUCCESS',
  });

  return ok({ success: true, account: created, opening_entry_id: openingEntryId });
};
