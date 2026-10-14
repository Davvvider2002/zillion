/**
 * zillion/backend/netlify/functions/coop-portal-chart-of-accounts-import.js
 *
 * POST /api/v1/coop-portal-chart-of-accounts-import
 * Body: { rows: [[cell,...],...] (the sheet as the browser read it), commit: boolean }
 *
 * commit=false: check the file and report exactly what would be created and what is wrong, saving nothing.
 * commit=true:  create every valid account. Rows with a problem are skipped and reported; codes that already exist are never overwritten.
 * Opening balances go in as ONE balanced journal entry against Opening Balance Equity (3900), so the books stay in balance and the
 * difference between the debits and credits you imported lands visibly in 3900 rather than breaking anything.
 */
'use strict';
const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT } = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');
const { hasAddon } = require('../../lib/coopEntitlements');
const { ensureChartOfAccounts } = require('../../lib/coopAccounting');
const { validateChartRows } = require('../../lib/chartImport');
const { auditLog } = require('../../lib/auditLog');

const MAX_ROWS = 2000;

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok = b => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c, m) => ({ statusCode: c, headers: hdr, body: JSON.stringify({ error: m }) });
  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  const db = getServiceClient();
  const resolved = await resolvePortalSociety(db, auth);
  if (!resolved.ok) return err(resolved.status, resolved.error);
  const coopId = resolved.society.coop_id;
  if (!(await hasAddon(db, coopId, 'accounting'))) return err(403, 'The Accounting & Finance module is not on your current plan');
  if (!(await requirePortalPermission(db, auth, 'accounting', 'create'))) return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return err(400, 'Invalid JSON'); }
  if (!Array.isArray(body.rows)) return err(400, 'No rows received');
  if (body.rows.length > MAX_ROWS) return err(400, `The file has more than ${MAX_ROWS} rows`);

  const baseCurrency = resolved.society.base_currency || 'NGN';
  await ensureChartOfAccounts(db, coopId, baseCurrency);
  const { data: existing } = await db.from('coop_chart_of_accounts').select('account_code').eq('coop_id', coopId);
  const existingCodes = new Set((existing || []).map(a => String(a.account_code).toLowerCase()));

  const v = validateChartRows(body.rows, existingCodes);
  if (!body.commit) return ok({ success: true, committed: false, ...v });
  if (!v.rows.length) return err(400, v.errors.length ? 'None of the rows could be imported. Fix the problems listed and try again.' : 'Nothing to import');

  const created = [];
  const errors = [...v.errors];
  for (const r of v.rows) {
    const { data, error } = await db.from('coop_chart_of_accounts').insert({
      coop_id: coopId, account_code: r.account_code, account_name: r.account_name, account_type: r.account_type, sub_type: r.sub_type, currency: baseCurrency,
    }).select().single();
    if (error || !data) { errors.push({ row: r.row, code: r.account_code, name: r.account_name, message: error && error.code === '23505' ? 'this code already exists' : 'could not be saved' }); continue; }
    created.push({ ...r, id: data.id });
  }

  let openingEntryId = null, openingNote = null;
  const withBal = created.filter(c => c.opening_kobo);
  if (withBal.length) {
    const { data: obe } = await db.from('coop_chart_of_accounts').select('id').eq('coop_id', coopId).eq('account_code', '3900').maybeSingle();
    if (!obe) openingNote = 'Opening balances were not posted because Opening Balance Equity (3900) was not found.';
    else {
      const { data: last } = await db.from('coop_journal_entries').select('entry_number').eq('coop_id', coopId).order('entry_number', { ascending: false }).limit(1).maybeSingle();
      const { data: entry } = await db.from('coop_journal_entries').insert({
        coop_id: coopId, entry_number: (last?.entry_number || 0) + 1, entry_date: new Date().toISOString().slice(0, 10),
        description: 'Opening balances — chart of accounts import', entry_type: 'manual', created_by: `portal:${auth.payload.merchant_id}`,
      }).select().single();
      if (entry) {
        const lines = withBal.map(c => ({ journal_entry_id: entry.id, coop_id: coopId, account_id: c.id, line_type: c.side, amount: c.opening_kobo, currency: baseCurrency, exchange_rate: 1, base_amount: c.opening_kobo }));
        const dr = withBal.filter(c => c.side === 'debit').reduce((s, c) => s + c.opening_kobo, 0);
        const cr = withBal.filter(c => c.side === 'credit').reduce((s, c) => s + c.opening_kobo, 0);
        if (dr !== cr) {
          const plugSide = dr > cr ? 'credit' : 'debit'; const plug = Math.abs(dr - cr);
          lines.push({ journal_entry_id: entry.id, coop_id: coopId, account_id: obe.id, line_type: plugSide, amount: plug, currency: baseCurrency, exchange_rate: 1, base_amount: plug, memo: 'Opening balance offset' });
        }
        const { error: lineErr } = await db.from('coop_journal_entry_lines').insert(lines);
        if (lineErr) { await db.from('coop_journal_entries').delete().eq('id', entry.id); openingNote = 'Accounts were created but the opening balances could not be posted. Post them from Journal Entries.'; }
        else openingEntryId = entry.id;
      } else openingNote = 'Accounts were created but the opening balances could not be posted. Post them from Journal Entries.';
    }
  }

  await auditLog(db, {
    action: 'COOP_PORTAL_CHART_IMPORTED', username: auth.payload.merchant_id, role: 'merchant',
    ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_chart_of_accounts', resourceId: coopId, requestBody: { created: created.length, skipped: errors.length }, result: 'SUCCESS',
  });
  return ok({ success: true, committed: true, created_count: created.length, skipped: errors, opening_entry_id: openingEntryId, opening_note: openingNote, totals: v.totals });
};
