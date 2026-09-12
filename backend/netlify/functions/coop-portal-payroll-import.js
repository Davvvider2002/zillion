/**
 * zillion/backend/netlify/functions/coop-portal-payroll-import.js
 *
 * POST /api/v1/coop-portal-payroll-import
 *
 * Bulk-creates employees with their initial salary in one pass -
 * same CSV parsing convention as coop-portal-bulk-import.js (member
 * import): simple header-driven column mapping, one row per employee,
 * per-row created/already_existed/failed tracking, 500-row cap.
 *
 * Genuinely new employees only - a row whose name (case-insensitive)
 * already matches an existing employee in this society is skipped as
 * already_existed rather than silently duplicating or overwriting an
 * existing employee's salary. Re-importing to change someone's
 * existing salary isn't what this endpoint is for - use "Set salary"
 * for that, which keeps effective-dated history properly.
 *
 * Expected CSV columns (header row required): name, employment_date,
 * basic_salary. Optional: job_title, phone, email, bank_name,
 * bank_account_number, tin, pension_rsa_number, housing_allowance,
 * transport_allowance, other_allowance. Column order doesn't matter.
 * Salary figures are in Naira.
 *
 * Body: { csv_text }
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety } = require('../../lib/coopPortalAuth');
const { hasAddon }             = require('../../lib/coopEntitlements');
const { auditLog }             = require('../../lib/auditLog');

const REQUIRED_COLUMNS = ['name', 'employment_date', 'basic_salary'];
const OPTIONAL_COLUMNS = [
  'job_title', 'phone', 'email', 'bank_name', 'bank_account_number', 'tin', 'pension_rsa_number',
  'housing_allowance', 'transport_allowance', 'other_allowance',
];

function parseCsv(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (!lines.length) return { rows: [], error: 'CSV is empty' };

  const headerCells = lines[0].split(',').map(c => c.trim().toLowerCase());
  for (const col of REQUIRED_COLUMNS) {
    if (headerCells.indexOf(col) === -1) return { rows: [], error: `CSV must have a "${col}" column in its header row` };
  }

  const colIdx = {};
  for (const col of [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS]) colIdx[col] = headerCells.indexOf(col);

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',').map(c => c.trim());
    const row = { lineNumber: i + 1 };
    for (const col of [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS]) {
      row[col] = colIdx[col] !== -1 ? (cells[colIdx[col]] || '') : '';
    }
    rows.push(row);
  }
  return { rows };
}

function parseNairaToKobo(value) {
  if (!value) return 0;
  const naira = parseFloat(value);
  if (isNaN(naira) || naira < 0) return null;
  return Math.round(naira * 100);
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

  if (!(await hasAddon(db, coopId, 'payroll'))) {
    return err(403, 'HR & Payroll is not enabled for this society. Add it from the Add-ons tab.');
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const csvText = (body.csv_text || '').trim();
  if (!csvText) return err(400, 'csv_text is required');

  const { rows, error: parseError } = parseCsv(csvText);
  if (parseError) return err(400, parseError);
  if (rows.length > 500) return err(400, `${rows.length} rows is too many for one import — split into batches of 500 or fewer`);

  const { data: existingEmployees } = await db.from('coop_employees').select('name').eq('coop_id', coopId);
  const existingNamesLower = new Set((existingEmployees || []).map(e => e.name.toLowerCase()));

  const today = new Date().toISOString().slice(0, 10);
  const results = [];
  let createdCount = 0, existedCount = 0, failedCount = 0;

  for (const row of rows) {
    if (!row.name) {
      results.push({ line: row.lineNumber, status: 'failed', error: 'No name in this row' });
      failedCount++;
      continue;
    }
    if (!row.employment_date) {
      results.push({ line: row.lineNumber, name: row.name, status: 'failed', error: 'No employment_date in this row' });
      failedCount++;
      continue;
    }
    if (existingNamesLower.has(row.name.toLowerCase())) {
      results.push({ line: row.lineNumber, name: row.name, status: 'already_existed' });
      existedCount++;
      continue;
    }

    const basicSalaryKobo = parseNairaToKobo(row.basic_salary);
    if (basicSalaryKobo === null || basicSalaryKobo <= 0) {
      results.push({ line: row.lineNumber, name: row.name, status: 'failed', error: `Invalid basic_salary: "${row.basic_salary}"` });
      failedCount++;
      continue;
    }

    const allowanceCols = [
      { key: 'housing_allowance', label: 'Housing Allowance' },
      { key: 'transport_allowance', label: 'Transport Allowance' },
      { key: 'other_allowance', label: 'Other Allowance' },
    ];
    let allowanceParseFailed = false;
    const allowances = [];
    for (const a of allowanceCols) {
      if (!row[a.key]) continue;
      const kobo = parseNairaToKobo(row[a.key]);
      if (kobo === null) { allowanceParseFailed = true; break; }
      if (kobo > 0) allowances.push({ name: a.label, amount_kobo: kobo });
    }
    if (allowanceParseFailed) {
      results.push({ line: row.lineNumber, name: row.name, status: 'failed', error: 'Invalid allowance amount' });
      failedCount++;
      continue;
    }

    const { data: created, error: insertErr } = await db.from('coop_employees').insert({
      coop_id: coopId, name: row.name, job_title: row.job_title || null, email: row.email || null,
      phone: row.phone || null, bank_name: row.bank_name || null, bank_account_number: row.bank_account_number || null,
      tin: row.tin || null, pension_rsa_number: row.pension_rsa_number || null, employment_date: row.employment_date,
    }).select().single();

    if (insertErr) {
      results.push({ line: row.lineNumber, name: row.name, status: 'failed', error: insertErr.message });
      failedCount++;
      continue;
    }

    const componentRows = [
      { employee_id: created.id, component_type: 'basic', component_name: 'Basic Salary', amount_kobo: basicSalaryKobo, effective_from: today },
      ...allowances.map(a => ({ employee_id: created.id, component_type: 'allowance', component_name: a.name, amount_kobo: a.amount_kobo, effective_from: today })),
    ];
    await db.from('coop_employee_salary_components').insert(componentRows);

    existingNamesLower.add(row.name.toLowerCase()); // guards against duplicate names within the same file
    results.push({ line: row.lineNumber, name: row.name, status: 'created' });
    createdCount++;
  }

  await auditLog(db, {
    action:       'COOP_PORTAL_PAYROLL_IMPORT',
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
