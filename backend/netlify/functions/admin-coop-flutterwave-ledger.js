/**
 * zillion/backend/netlify/functions/admin-coop-flutterwave-ledger.js
 *
 * GET /api/v1/admin-coop-flutterwave-ledger
 *
 * Zillion's view across EVERY society of the money Flutterwave collects for them: how much is waiting to settle, how much
 * Zillion itself is holding on their behalf (bank transfers into members' virtual accounts land in Zillion's balance and
 * are owed on), when each last settled, and - most usefully - which societies need attention and why.
 *
 * The numbers are added up by the database in one pass (coop_flutterwave_platform_summary), not by looping over societies.
 * For one society's full ledger, see coop-portal-flutterwave-ledger.js.
 *
 * Auth: SUPER_ADMIN or OPERATIONS.
 */
'use strict';

const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { fetchAllRows }           = require('../../lib/coopPaginate');
const { isLiveMode, STALE_HELD_DAYS } = require('../../lib/coopFlutterwaveLedger');

const naira = k => '₦' + (k / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Why a society needs attention, in plain words (empty = all clear). Exported for tests. */
function attentionReasons(r, society, now = new Date()) {
  const why = [];
  if (r.difference_kobo !== 0) why.push(`Ledger and books disagree by ${naira(Math.abs(r.difference_kobo))}`);
  if (r.unmatched_settlements > 0) why.push(`${r.unmatched_settlements} settlement(s) do not match the payments they cover`);
  if (r.wrong_account_settlements > 0) why.push(`${r.wrong_account_settlements} settlement(s) were paid to a different account than the one selected`);
  if (r.rows_without_journal > 0) why.push(`${r.rows_without_journal} ledger row(s) have no journal entry`);
  if (r.held_count > 0 && r.oldest_held_at && (now - new Date(r.oldest_held_at)) / 86400000 > STALE_HELD_DAYS) why.push(`Payments unsettled for more than ${STALE_HELD_DAYS} days`);
  if ((r.held_count > 0 || r.owed_count > 0) && society && !society.settlement_account_number) why.push('Money is waiting but no settlement bank account is on file');
  return why;
}

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');
  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ['SUPER_ADMIN', 'OPERATIONS'])) return err(403, 'SUPER_ADMIN or OPERATIONS required');

  const db = getServiceClient();
  try {
    const { data: rows, error } = await db.rpc('coop_flutterwave_platform_summary');
    if (error) return err(500, `Could not read the platform summary: ${error.message}`);
    const byCoop = new Map((rows || []).map(r => [r.coop_id, r]));

    const societies = await fetchAllRows(() => db.from('coop_societies')
      .select('coop_id, name, status, flutterwave_subaccount_id, settlement_account_name, settlement_account_number, settlement_account_code').order('coop_id'));
    const now = new Date();
    const blank = { in_kobo: 0, out_kobo: 0, held_kobo: 0, held_count: 0, oldest_held_at: null, owed_kobo: 0, owed_count: 0, last_settlement_at: null,
      unmatched_settlements: 0, wrong_account_settlements: 0, test_rows: 0, rows_without_journal: 0, gl_kobo: 0, difference_kobo: 0 };

    const list = [];
    for (const s of societies) {
      const r = byCoop.get(s.coop_id);
      if (!r && !s.flutterwave_subaccount_id) continue;      // never set up for Flutterwave collections and nothing happened: not interesting here
      const row = { ...blank, ...(r || {}) };
      const why = attentionReasons(row, s, now);
      list.push({
        coop_id: s.coop_id, name: s.name, status: s.status, has_subaccount: !!s.flutterwave_subaccount_id,
        settlement_account: s.settlement_account_number ? `${s.settlement_account_name || ''} ${s.settlement_account_number}`.trim() : null,
        books_account_selected: !!s.settlement_account_code, has_activity: !!r,
        held_kobo: row.held_kobo, held_count: row.held_count, oldest_held_days: row.oldest_held_at ? Math.floor((now - new Date(row.oldest_held_at)) / 86400000) : null,
        owed_by_zillion_kobo: row.owed_kobo, owed_count: row.owed_count, collected_kobo: row.in_kobo, settled_kobo: row.out_kobo, last_settlement_at: row.last_settlement_at,
        test_rows: row.test_rows, difference_kobo: row.difference_kobo, attention: why,
      });
    }
    // anything with books/ledger activity for a society that no longer exists in coop_societies would be invisible above - say so
    const known = new Set(societies.map(s => s.coop_id));
    const orphans = (rows || []).filter(r => !known.has(r.coop_id)).map(r => r.coop_id);

    list.sort((a, b) => (b.attention.length > 0) - (a.attention.length > 0) || b.owed_by_zillion_kobo - a.owed_by_zillion_kobo || b.held_kobo - a.held_kobo || String(a.name).localeCompare(String(b.name)));
    return ok({
      live_key: isLiveMode(),
      totals: {
        held_by_flutterwave_kobo: list.reduce((t, s) => t + s.held_kobo, 0),
        owed_by_zillion_kobo: list.reduce((t, s) => t + s.owed_by_zillion_kobo, 0),
        collected_kobo: list.reduce((t, s) => t + s.collected_kobo, 0), settled_kobo: list.reduce((t, s) => t + s.settled_kobo, 0),
        societies_listed: list.length, societies_with_activity: list.filter(s => s.has_activity).length, societies_needing_attention: list.filter(s => s.attention.length).length,
      },
      societies: list, orphaned_coop_ids: orphans,
    });
  } catch (e) {
    return err(500, `Platform Flutterwave summary failed: ${e.message}`);
  }
};

exports.attentionReasons = attentionReasons;
