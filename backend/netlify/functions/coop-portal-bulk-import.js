/**
 * zillion/backend/netlify/functions/coop-portal-bulk-import.js
 *
 * POST /api/v1/coop-portal-bulk-import
 *
 * Society-admin self-service version of admin-coop-bulk-import.js.
 * Identical CSV parsing and activateMember() logic — coop_id is
 * simply the caller's own resolved society rather than a client-
 * supplied value, so no separate "does this CSV belong to you" check
 * is needed the way savings/loan actions require (there's no existing
 * resource to own here — only new members being created).
 *
 * Expected CSV columns (header row required): phone, name,
 * opening_balance (optional, in Naira). Column order doesn't matter.
 *
 * Body: { csv_text }
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');
const { auditLog }             = require('../../lib/auditLog');
const { activateMember }       = require('../../lib/coopActivateMember');
const { checkMemberCapAllows } = require('../../lib/coopMemberCap');

function parseCsv(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (!lines.length) return { rows: [], error: 'CSV is empty' };

  // Auto-detect the delimiter rather than assume comma - pasting
  // cells directly from Excel produces tab-separated text, not
  // comma-separated, and a comma-only parser would see the entire
  // header row as a single column, never finding "phone" even though
  // it's right there as the first word.
  const headerLine = lines[0];
  const delimiter = [',', '\t', ';']
    .map(d => ({ d, count: headerLine.split(d).length }))
    .sort((a, b) => b.count - a.count)[0].d;

  const headerCells = headerLine.split(delimiter).map(c => c.trim().toLowerCase());
  const PHONE_ALIASES = ['phone', 'phone number', 'phone_number', 'mobile', 'mobile number', 'tel', 'telephone'];
  const phoneIdx = headerCells.findIndex(c => PHONE_ALIASES.includes(c));
  const nameIdx = headerCells.indexOf('name');
  const balanceIdx = headerCells.indexOf('opening_balance');

  if (phoneIdx === -1) {
    return { rows: [], error: `CSV must have a "phone" column in its header row. Detected header: [${headerCells.map(c => `"${c}"`).join(', ')}] (using "${delimiter === '\t' ? 'tab' : delimiter}" as the separator).` };
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(delimiter).map(c => c.trim());
    rows.push({
      lineNumber: i + 1,
      phone: cells[phoneIdx] || '',
      name: nameIdx !== -1 ? (cells[nameIdx] || '') : '',
      openingBalanceNaira: balanceIdx !== -1 ? (cells[balanceIdx] || '') : '',
    });
  }
  return { rows };
}

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

  if (!(await requirePortalPermission(db, auth, 'members', 'create'))) {
    return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const csvText = (body.csv_text || '').trim();
  if (!csvText) return err(400, 'csv_text is required');

  const { rows, error: parseError } = parseCsv(csvText);
  if (parseError) return err(400, parseError);
  if (rows.length > 500) return err(400, `${rows.length} rows is too many for one import — split into batches of 500 or fewer`);

  const capCheck = await checkMemberCapAllows(db, coopId, rows.length);
  if (!capCheck.ok) return err(403, capCheck.error);

  const activatedBy = `portal:${auth.payload.merchant_id}`;
  const results = [];
  let createdCount = 0, existedCount = 0, failedCount = 0;

  for (const row of rows) {
    if (!row.phone) {
      results.push({ line: row.lineNumber, status: 'failed', error: 'No phone number in this row' });
      failedCount++;
      continue;
    }
    const openingBalanceKobo = row.openingBalanceNaira ? Math.round(parseFloat(row.openingBalanceNaira) * 100) : 0;
    if (row.openingBalanceNaira && (isNaN(openingBalanceKobo) || openingBalanceKobo < 0)) {
      results.push({ line: row.lineNumber, phone: row.phone, status: 'failed', error: `Invalid opening_balance: "${row.openingBalanceNaira}"` });
      failedCount++;
      continue;
    }

    const result = await activateMember(db, {
      coopId, rawPhone: row.phone, name: row.name, openingBalanceKobo, activatedBy,
    });

    if (result.status === 'created') {
      results.push({ line: row.lineNumber, phone: result.phone, name: row.name, status: 'created' });
      createdCount++;
    } else if (result.status === 'already_existed') {
      results.push({ line: row.lineNumber, phone: result.phone, name: row.name, status: 'already_existed' });
      existedCount++;
    } else {
      results.push({ line: row.lineNumber, phone: row.phone, status: 'failed', error: result.error });
      failedCount++;
    }
  }

  await auditLog(db, {
    action:       'COOP_PORTAL_BULK_IMPORT',
    username:     auth.payload.merchant_id,
    role:         'merchant',
    ip:           event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_society',
    resourceId:   coopId,
    requestBody:  { row_count: rows.length },
    result:       'SUCCESS',
  });

  return ok({
    success: true,
    summary: { total: rows.length, created: createdCount, already_existed: existedCount, failed: failedCount },
    results,
  });
};
