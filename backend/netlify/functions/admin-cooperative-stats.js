/**
 * zillion/backend/netlify/functions/admin-cooperative-stats.js
 *
 * GET /api/v1/admin-cooperative-stats?coop_id=X
 *
 * Aggregated view of a cooperative's combined sales — the core value
 * of the cooperative concept: seeing what the group sold together,
 * not just tracking membership. Sums coin_ledger arrivals (money
 * received) across all member holder_hashes, plus a per-member
 * breakdown so an admin can see who's contributing what.
 */
'use strict';

const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ['SUPER_ADMIN','COMPLIANCE','OPERATIONS','SUPPORT','AUDITOR','VIEWER']))
    return err(403, 'Admin access required');

  const coopId = (event.queryStringParameters || {}).coop_id;
  if (!coopId) return err(400, 'coop_id query parameter required');

  const db = getServiceClient();

  const { data: coop } = await db.from('cooperatives').select('*').eq('coop_id', coopId).single();
  if (!coop) return err(404, `Unknown coop_id: ${coopId}`);

  const { data: members, error: memErr } = await db
    .from('cooperative_members')
    .select('holder_hash, member_name, member_phone')
    .eq('coop_id', coopId);
  if (memErr) return err(500, memErr.message);

  if (!members || members.length === 0) {
    return ok({ cooperative: coop, member_count: 0, total_sales_kobo: 0, transaction_count: 0, members: [] });
  }

  const holderHashes = members.map(m => m.holder_hash);

  // Total across every member — arrivals only (money received), matching
  // the same coin_ledger arrivals logic used by coin_ledger_holder_balance.
  const { data: ledgerRows, error: ledgerErr } = await db
    .from('coin_ledger')
    .select('amount, new_holder_hash')
    .in('new_holder_hash', holderHashes)
    .eq('new_status', 'HELD');
  if (ledgerErr) return err(500, ledgerErr.message);

  const perMemberTotals = {};
  let totalKobo = 0;
  (ledgerRows || []).forEach(row => {
    totalKobo += row.amount || 0;
    perMemberTotals[row.new_holder_hash] = (perMemberTotals[row.new_holder_hash] || 0) + (row.amount || 0);
  });

  const memberBreakdown = members.map(m => ({
    holder_hash:  m.holder_hash,
    member_name:  m.member_name,
    member_phone: m.member_phone,
    total_kobo:   perMemberTotals[m.holder_hash] || 0,
  })).sort((a, b) => b.total_kobo - a.total_kobo);

  return ok({
    cooperative:       coop,
    member_count:      members.length,
    total_sales_kobo:  totalKobo,
    transaction_count: (ledgerRows || []).length,
    members:           memberBreakdown,
  });
};
