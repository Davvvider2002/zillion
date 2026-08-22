/**
 * zillion/backend/netlify/functions/admin-coop-bulk-import.js
 *
 * POST /api/v1/admin-coop-bulk-import
 *
 * Bulk-activates members from a CSV — the real barrier this closes:
 * a society with 100+ existing members shouldn't need one-by-one
 * activation through the UI. Reuses the exact same activateMember()
 * logic as the single-member endpoint (backend/lib/coopActivateMember.js)
 * — same identity resolution, same wallet pre-provisioning, same
 * "already exists" handling — just looped, so behavior never drifts
 * between the two paths.
 *
 * Processes every row even if some fail — one bad phone number
 * shouldn't block 99 good ones. Returns a per-row result summary so
 * the admin can see exactly what happened, not just a pass/fail count.
 *
 * Expected CSV columns (header row required): phone, name,
 * opening_balance (optional, in Naira — converted to kobo here).
 * Column order doesn't matter as long as headers match; unrecognized
 * extra columns are ignored rather than rejected.
 *
 * Simple comma-split parsing, not a full RFC 4180 parser — deliberate:
 * phone numbers, names, and amounts don't realistically need embedded
 * commas or quoted fields, and a heavier parser isn't worth the
 * complexity for this specific, narrow data shape.
 *
 * Auth: SUPER_ADMIN or OPERATIONS.
 * Body: { coop_id, csv_text }
 */
'use strict';

const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { auditLog }               = require('../../lib/auditLog');
const { activateMember }         = require('../../lib/coopActivateMember');

function parseCsv(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (!lines.length) return { rows: [], error: 'CSV is empty' };

  const headerCells = lines[0].split(',').map(c => c.trim().toLowerCase());
  const phoneIdx = headerCells.indexOf('phone');
  const nameIdx = headerCells.indexOf('name');
  const balanceIdx = headerCells.indexOf('opening_balance');

  if (phoneIdx === -1) return { rows: [], error: 'CSV must have a "phone" column in its header row' };

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',').map(c => c.trim());
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
  if (!requireRole(auth, ['SUPER_ADMIN', 'OPERATIONS']))
    return err(403, 'SUPER_ADMIN or OPERATIONS role required to bulk-import members');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const coopId   = (body.coop_id || '').trim();
  const csvText  = (body.csv_text || '').trim();

  if (!coopId)  return err(400, 'coop_id is required');
  if (!csvText)  return err(400, 'csv_text is required');

  const db = getServiceClient();

  const { data: coop } = await db.from('coop_societies').select('coop_id, name, status').eq('coop_id', coopId).single();
  if (!coop) return err(400, `Unknown coop_id: ${coopId}`);
  if (coop.status === 'SUSPENDED') return err(403, `${coop.name}'s access is currently suspended`);

  const { rows, error: parseError } = parseCsv(csvText);
  if (parseError) return err(400, parseError);
  if (rows.length > 500) return err(400, `${rows.length} rows is too many for one import — split into batches of 500 or fewer`);

  const activatedBy = auth.payload.username || auth.payload.sub;
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
    action:       'COOP_BULK_IMPORT',
    username:     activatedBy,
    role:         auth.payload.role,
    ip:           event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_society',
    resourceId:   coopId,
    requestBody:  { coop_id: coopId, row_count: rows.length },
    result:       'SUCCESS',
  });

  return ok({
    success: true,
    summary: { total: rows.length, created: createdCount, already_existed: existedCount, failed: failedCount },
    results,
  });
};
