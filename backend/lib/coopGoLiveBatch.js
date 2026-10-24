/**
 * zillion/backend/lib/coopGoLiveBatch.js
 *
 * Go-live catch-up, foundations. A society that starts on Zillion part way through its financial year needs to bring
 * in what already happened, with the real dates, so dividends and reports count it. Every such record belongs to a
 * migration batch (coop_migration_batches) and carries a real date. This file is the one place that decides whether
 * a request may use a past date.
 *
 * The rule that protects live books: a past date is accepted ONLY together with a migration batch that is still in
 * draft, belongs to the caller's society, and whose window (fy_start to cutover_date) contains the date. Without a
 * batch, nothing changes: records are stamped now, exactly as before.
 */
'use strict';

// Noon in Nigeria (UTC+1) keeps the stamp on the same calendar day in both UTC and Lagos.
const NOON_WAT = 'T12:00:00+01:00';
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function isRealDay(s) {
  if (typeof s !== 'string' || !ISO_DAY.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** @returns {{ok:true, day:string, recordedAt:string}|{ok:false, error:string}} */
function parseDay(input, label = 'as_of_date') {
  const s = String(input == null ? '' : input).trim();
  if (!isRealDay(s)) return { ok: false, error: `${label} must be a real date written YYYY-MM-DD.` };
  return { ok: true, day: s, recordedAt: s + NOON_WAT };
}

/**
 * Reads the optional go-live fields from a request body.
 * Returns { ok:true, active:false } when the caller sent neither field: the normal, live path.
 * Returns { ok:true, active:true, batch, day, recordedAt, opts } for a valid catch-up record, where `opts` is what the
 * journal posting helpers take ({ entryDate, batchId }).
 * Sending only one of the two fields is an error, so a stray date can never backdate a live record.
 */
async function resolveGoLiveInput(db, coopId, body) {
  const batchId = body && body.migration_batch_id != null ? String(body.migration_batch_id).trim() : '';
  const asOf    = body && body.as_of_date != null ? String(body.as_of_date).trim() : '';
  if (!batchId && !asOf) return { ok: true, active: false };
  if (!batchId) return { ok: false, status: 400, error: 'as_of_date can only be used with a go-live migration_batch_id.' };
  if (!asOf)    return { ok: false, status: 400, error: 'as_of_date is required when migration_batch_id is given.' };

  const parsed = parseDay(asOf);
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };

  const { data: batch } = await db.from('coop_migration_batches')
    .select('id, coop_id, status, fy_start, cutover_date').eq('id', batchId).maybeSingle();
  if (!batch)                  return { ok: false, status: 404, error: 'Migration batch not found.' };
  if (batch.coop_id !== coopId) return { ok: false, status: 403, error: 'This migration batch does not belong to your society.' };
  if (batch.status !== 'draft') return { ok: false, status: 409, error: `This migration batch is ${batch.status}. Only a draft batch accepts records.` };
  if (parsed.day < batch.fy_start || parsed.day > batch.cutover_date) {
    return { ok: false, status: 400, error: `as_of_date must fall between the financial year start (${batch.fy_start}) and the cutover date (${batch.cutover_date}).` };
  }
  return {
    ok: true, active: true, batch, day: parsed.day, recordedAt: parsed.recordedAt,
    opts: { entryDate: parsed.day, batchId: batch.id },
  };
}

module.exports = { parseDay, isRealDay, resolveGoLiveInput, NOON_WAT };
