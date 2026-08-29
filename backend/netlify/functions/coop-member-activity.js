/**
 * zillion/backend/netlify/functions/coop-member-activity.js
 *
 * GET /api/v1/coop-member-activity
 *
 * The coop-flavored wallet's History screen shows Zil coin transfers
 * by default, which is meaningless for a cooperative member whose
 * real activity is savings, dues, loans, and dividends (all separate
 * ledgers from Zil coins entirely). This merges all of them into one
 * chronological list so History shows something actually relevant to
 * a coop member.
 *
 * Auth: any valid wallet JWT for a real coop member (same identity
 * resolution as coop-member-status.js).
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  const zillionId = auth.payload.zillion_id;
  if (!zillionId) return ok({ is_coop_member: false, activity: [] });

  const db = getServiceClient();
  const { data: member } = await db.from('coop_members').select('id').eq('zillion_id', zillionId).maybeSingle();
  if (!member) return ok({ is_coop_member: false, activity: [] });

  const { data: savingsTxns } = await db.from('coop_savings_transactions')
    .select('amount_kobo, source, created_at').eq('member_id', member.id).order('created_at', { ascending: false }).limit(100);
  const { data: duesTxns } = await db.from('coop_dues_transactions')
    .select('amount_kobo, source, created_at').eq('member_id', member.id).order('created_at', { ascending: false }).limit(100);

  const { data: loans } = await db.from('coop_loans')
    .select('id, principal_kobo, disbursed_at').eq('member_id', member.id).not('disbursed_at', 'is', null);
  const loanMap = new Map((loans || []).map(l => [l.id, l]));

  const { data: repayments } = await db.from('coop_loan_repayments')
    .select('loan_id, amount_kobo, source, recorded_at, coop_loans!inner(member_id)')
    .eq('coop_loans.member_id', member.id).order('recorded_at', { ascending: false }).limit(100);

  const { data: dividends } = await db.from('coop_dividend_entitlements')
    .select('entitlement_kobo, coop_dividend_runs!inner(status, approved_at)')
    .eq('member_id', member.id).eq('coop_dividend_runs.status', 'approved');

  const activity = [
    ...(savingsTxns || []).map(t => ({ type: 'savings', amount_kobo: t.amount_kobo, source: t.source, ts: t.created_at })),
    ...(duesTxns || []).map(t => ({ type: 'dues', amount_kobo: t.amount_kobo, source: t.source, ts: t.created_at })),
    ...(loans || []).map(l => ({ type: 'loan_disbursed', amount_kobo: l.principal_kobo, ts: l.disbursed_at })),
    ...(repayments || []).map(r => ({ type: 'loan_repayment', amount_kobo: r.amount_kobo, source: r.source, ts: r.recorded_at })),
    ...(dividends || []).map(d => ({ type: 'dividend', amount_kobo: d.entitlement_kobo, ts: d.coop_dividend_runs.approved_at })),
  ].sort((a, b) => new Date(b.ts) - new Date(a.ts));

  return ok({ is_coop_member: true, activity });
};
