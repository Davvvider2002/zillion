/**
 * zillion/backend/netlify/functions/coop-portal-journal-entry.js
 *
 * GET    /api/v1/coop-portal-journal-entry                    — list entries (with lines)
 * POST   /api/v1/coop-portal-journal-entry                    — create a manual journal entry
 * PATCH  /api/v1/coop-portal-journal-entry?entry_id=<uuid>     — edit a manual entry (replaces its lines)
 * DELETE /api/v1/coop-portal-journal-entry?entry_id=<uuid>     — delete a manual entry
 *
 * Edit and delete are gated separately from create (requirePortalPermission's
 * 'edit'/'delete' actions) and only ever apply to entry_type='manual' -
 * anything system-generated (opening balances, payroll postings,
 * reconciliation resolutions) stays immutable through this endpoint,
 * since editing it freely would silently disconnect it from whatever
 * actually created it.
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
 * Body (POST/PATCH): {
 *   entry_date, description,
 *   lines: [{ account_id, line_type: 'debit'|'credit', amount, exchange_rate?, memo? }]
 * }
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');
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
    if (!(await requirePortalPermission(db, auth, 'accounting', 'view'))) {
      return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');
    }
    await recordDuesAccrual(db, coopId); // on-demand check — doesn't require waiting for the next scheduled run
    const { data: entries, error } = await db.from('coop_journal_entries')
      .select('*, coop_journal_entry_lines(*, coop_chart_of_accounts(account_code, account_name))')
      .eq('coop_id', coopId).order('entry_number', { ascending: false }).limit(200);
    if (error) return err(500, error.message);
    return ok({ entries });
  }

  if (event.httpMethod === 'PATCH') return handleEdit(db, auth, coopId, resolved, event, ok, err);
  if (event.httpMethod === 'DELETE') return handleDelete(db, auth, coopId, event, ok, err);

  if (!(await requirePortalPermission(db, auth, 'accounting', 'create'))) {
    return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');
  }

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const entryDate    = (body.entry_date || '').trim();
  const description   = (body.description || '').trim();
  const inputLines       = Array.isArray(body.lines) ? body.lines : [];

  const validated = await validateAndResolveLines(db, coopId, resolved.society.base_currency, entryDate, description, inputLines);
  if (!validated.ok) return err(validated.status, validated.error);
  const resolvedLines = validated.resolvedLines;

  const closedYearCheck = await isDateInClosedFinancialYear(db, coopId, entryDate);
  if (closedYearCheck) return err(400, `${entryDate} falls within "${closedYearCheck.year_label}", which is already closed (${closedYearCheck.start_date} to ${closedYearCheck.end_date}) — reopen that year first if this entry genuinely needs to be posted there.`);


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

  let reconciliationResolved = false;
  if (body.reconciliation_line_id) {
    const { data: reconLine } = await db.from('coop_bank_statement_lines')
      .select('id, batch_id').eq('id', body.reconciliation_line_id).eq('coop_id', coopId).maybeSingle();

    if (reconLine) {
      // Bank account (1010) is an asset - a debit to it means the
      // balance went UP (money arrived, a "credit" on the actual bank
      // statement); a credit to it means the balance went DOWN (money
      // left, a "debit" on the statement). This is the standard
      // asset-account polarity, just the opposite direction from how
      // banks describe their own statements.
      const bankLine = resolvedLines.find(l => l.accountCode === '1010');
      const direction = bankLine ? (bankLine.lineType === 'debit' ? 'credit' : 'debit') : null;

      await db.from('coop_bank_statement_lines').update({
        match_status: 'matched',
        resolved_journal_entry_id: entry.id,
        ...(direction ? { direction } : {}),
      }).eq('id', reconLine.id);

      // Keep the batch's own matched_lines count honest too, so the
      // upload-summary figure shown elsewhere doesn't silently drift
      // from what the detail view actually shows.
      const { count: matchedCount } = await db.from('coop_bank_statement_lines')
        .select('id', { count: 'exact', head: true }).eq('batch_id', reconLine.batch_id).eq('match_status', 'matched');
      await db.from('coop_bank_reconciliation_batches').update({ matched_lines: matchedCount || 0 }).eq('id', reconLine.batch_id);

      reconciliationResolved = true;
    }
  }

  return ok({ success: true, entry_number: nextNumber, entry_id: entry.id, reconciliation_resolved: reconciliationResolved });
};

/**
 * Shared by both create and edit - validates and resolves the
 * account/line_type/amount/exchange_rate for every line of a manual
 * journal entry. Returns the same resolvedLines shape linesAreBalanced()
 * and the insert logic both already expect.
 */
/**
 * Returns the closed financial-year row an entry_date falls inside,
 * or null if it's outside every closed year (or no years are closed
 * at all). Only years with an actual posted closing_entry_id count -
 * a year that's merely been computed as a snapshot (old rows from
 * before this check existed) doesn't block anything.
 */
async function isDateInClosedFinancialYear(db, coopId, entryDate) {
  if (!entryDate) return null;
  const { data } = await db.from('coop_financial_years')
    .select('year_label, start_date, end_date')
    .eq('coop_id', coopId).not('closing_entry_id', 'is', null)
    .lte('start_date', entryDate).gte('end_date', entryDate).maybeSingle();
  return data || null;
}

async function validateAndResolveLines(db, coopId, baseCurrency, entryDate, description, inputLines) {
  if (!entryDate) return { ok: false, status: 400, error: 'entry_date is required' };
  if (!description) return { ok: false, status: 400, error: 'description is required' };
  if (inputLines.length < 2) return { ok: false, status: 400, error: 'At least two lines are required for a double-entry' };

  const accountIds = [...new Set(inputLines.map(l => l.account_id))];
  const { data: accounts } = await db.from('coop_chart_of_accounts').select('id, account_code, currency, active').eq('coop_id', coopId).in('id', accountIds);
  const accountMap = new Map((accounts || []).map(a => [a.id, a]));

  const resolvedLines = [];
  for (const l of inputLines) {
    const account = accountMap.get(l.account_id);
    if (!account) return { ok: false, status: 400, error: `Unknown account: ${l.account_id}` };
    if (!account.active) return { ok: false, status: 400, error: 'One of the selected accounts is inactive' };
    if (!['debit', 'credit'].includes(l.line_type)) return { ok: false, status: 400, error: 'Each line must be debit or credit' };
    const amount = Number.isInteger(l.amount) && l.amount > 0 ? l.amount : null;
    if (!amount) return { ok: false, status: 400, error: 'Each line needs a positive integer amount' };
    const exchangeRate = account.currency === baseCurrency ? 1 : (Number(l.exchange_rate) > 0 ? Number(l.exchange_rate) : null);
    if (!exchangeRate) return { ok: false, status: 400, error: `A positive exchange_rate is required for a non-base-currency line (account currency: ${account.currency})` };
    resolvedLines.push({
      accountId: l.account_id, accountCode: account.account_code, lineType: l.line_type, amount, currency: account.currency,
      exchangeRate, baseAmount: Math.round(amount * exchangeRate), memo: (l.memo || '').trim() || null,
    });
  }
  return { ok: true, resolvedLines };
}

/**
 * PATCH /api/v1/coop-portal-journal-entry?entry_id=<uuid>
 * Body: { entry_date, description, lines: [...] }
 *
 * Only entries this portal itself created manually can be edited -
 * never opening_balance or anything else system-generated, since
 * those exist to represent something specific (the one-time opening
 * position, a payroll run, a reconciliation resolution) that editing
 * freely would silently disconnect from what actually created it.
 * Replaces the entry's lines wholesale rather than patching individual
 * ones - simpler, and avoids a half-updated entry if only some fields
 * changed.
 */
async function handleEdit(db, auth, coopId, resolved, event, ok, err) {
  if (!(await requirePortalPermission(db, auth, 'accounting', 'edit'))) {
    return err(403, 'You do not have access to edit journal entries. Ask your society admin to grant it.');
  }

  const entryId = event.queryStringParameters?.entry_id;
  if (!entryId) return err(400, 'entry_id query param is required');

  const { data: existing } = await db.from('coop_journal_entries').select('id, entry_type').eq('id', entryId).eq('coop_id', coopId).maybeSingle();
  if (!existing) return err(404, 'Journal entry not found in your society');
  if (existing.entry_type !== 'manual') return err(400, `A ${existing.entry_type.replace(/_/g, ' ')} entry can't be edited directly — it was generated by another part of the system.`);

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const entryDate = (body.entry_date || '').trim();
  const description = (body.description || '').trim();
  const inputLines = Array.isArray(body.lines) ? body.lines : [];

  const validated = await validateAndResolveLines(db, coopId, resolved.society.base_currency, entryDate, description, inputLines);
  if (!validated.ok) return err(validated.status, validated.error);
  const resolvedLines = validated.resolvedLines;

  const closedYearCheck = await isDateInClosedFinancialYear(db, coopId, entryDate);
  if (closedYearCheck) return err(400, `${entryDate} falls within "${closedYearCheck.year_label}", which is already closed (${closedYearCheck.start_date} to ${closedYearCheck.end_date}) — reopen that year first if this entry genuinely needs to be posted there.`);


  if (!linesAreBalanced(resolvedLines)) {
    const totalDebit = resolvedLines.filter(l => l.lineType === 'debit').reduce((s, l) => s + l.baseAmount, 0);
    const totalCredit = resolvedLines.filter(l => l.lineType === 'credit').reduce((s, l) => s + l.baseAmount, 0);
    return err(400, `Entry doesn't balance — debits total ${totalDebit}, credits total ${totalCredit} (in ${resolved.society.base_currency || 'base currency'})`);
  }

  const { error: updateErr } = await db.from('coop_journal_entries').update({ entry_date: entryDate, description }).eq('id', entryId);
  if (updateErr) return err(500, `Failed to update entry: ${updateErr.message}`);

  await db.from('coop_journal_entry_lines').delete().eq('journal_entry_id', entryId);
  const { error: linesErr } = await db.from('coop_journal_entry_lines').insert(
    resolvedLines.map(l => ({
      journal_entry_id: entryId, coop_id: coopId, account_id: l.accountId, line_type: l.lineType,
      amount: l.amount, currency: l.currency, exchange_rate: l.exchangeRate, base_amount: l.baseAmount, memo: l.memo,
    }))
  );
  if (linesErr) return err(500, `Failed to save updated lines: ${linesErr.message}`);

  await auditLog(db, {
    action: 'COOP_PORTAL_JOURNAL_ENTRY_EDITED', username: auth.payload.merchant_id, role: auth.payload.role,
    ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_journal_entry', resourceId: entryId, requestBody: body, result: 'SUCCESS',
  });

  return ok({ success: true, entry_id: entryId });
}

/**
 * DELETE /api/v1/coop-portal-journal-entry?entry_id=<uuid>
 *
 * Same manual-only restriction as edit. If this entry was the one
 * that resolved an unmatched bank reconciliation line (posted via the
 * suggested-journal-entry flow), deleting it reverts that line back
 * to unmatched rather than leaving it incorrectly marked resolved
 * against an entry that no longer exists.
 */
async function handleDelete(db, auth, coopId, event, ok, err) {
  if (!(await requirePortalPermission(db, auth, 'accounting', 'delete'))) {
    return err(403, 'You do not have access to delete journal entries. Ask your society admin to grant it.');
  }

  const entryId = event.queryStringParameters?.entry_id;
  if (!entryId) return err(400, 'entry_id query param is required');

  const { data: existing } = await db.from('coop_journal_entries').select('id, entry_type').eq('id', entryId).eq('coop_id', coopId).maybeSingle();
  if (!existing) return err(404, 'Journal entry not found in your society');
  if (existing.entry_type !== 'manual') return err(400, `A ${existing.entry_type.replace(/_/g, ' ')} entry can't be deleted directly — it was generated by another part of the system.`);

  const { data: linkedReconLines } = await db.from('coop_bank_statement_lines')
    .select('id, batch_id').eq('resolved_journal_entry_id', entryId);

  await db.from('coop_journal_entry_lines').delete().eq('journal_entry_id', entryId);
  const { error: deleteErr } = await db.from('coop_journal_entries').delete().eq('id', entryId);
  if (deleteErr) return err(500, `Failed to delete entry: ${deleteErr.message}`);

  if (linkedReconLines && linkedReconLines.length) {
    await db.from('coop_bank_statement_lines').update({ match_status: 'unmatched', resolved_journal_entry_id: null }).eq('resolved_journal_entry_id', entryId);
    const batchIds = [...new Set(linkedReconLines.map(l => l.batch_id))];
    for (const batchId of batchIds) {
      const { count: matchedCount } = await db.from('coop_bank_statement_lines')
        .select('id', { count: 'exact', head: true }).eq('batch_id', batchId).eq('match_status', 'matched');
      await db.from('coop_bank_reconciliation_batches').update({ matched_lines: matchedCount || 0 }).eq('id', batchId);
    }
  }

  await auditLog(db, {
    action: 'COOP_PORTAL_JOURNAL_ENTRY_DELETED', username: auth.payload.merchant_id, role: auth.payload.role,
    ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_journal_entry', resourceId: entryId, requestBody: {}, result: 'SUCCESS',
  });

  return ok({ success: true, reconciliation_lines_reverted: (linkedReconLines || []).length });
}
