/**
 * zillion/backend/netlify/functions/coop-member-status.js
 *
 * GET /api/v1/coop-member-status
 *
 * A member's own Thrift & Loan view: their savings plan(s) with live
 * progress, their loan(s) and status, and any guarantor requests
 * waiting on their response. This is what the wallet's Thrift & Loan
 * balance section calls.
 *
 * Savings progress is computed live from coin_ledger — summing actual
 * confirmed transfers from this member's own holder_hash to the
 * society's (merchant-held coins use holder_hash = merchant_id
 * directly, same as agents) — never a separately-stored figure that
 * could drift out of sync with what actually happened.
 *
 * Auth: wallet JWT (the member's own token).
 */
'use strict';

const crypto = require('crypto');
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
  if (!zillionId) return ok({ is_coop_member: false });

  const db = getServiceClient();

  const { data: member } = await db.from('coop_members')
    .select('id, coop_id, name, phone_normalized, opening_balance_kobo, status, coop_societies(name)')
    .eq('zillion_id', zillionId).maybeSingle();

  if (!member) return ok({ is_coop_member: false });

  const { data: society } = await db.from('coop_societies').select('merchant_id, name').eq('coop_id', member.coop_id).single();

  const memberHolderHash = crypto.createHash('sha256').update(member.phone_normalized).digest('hex');

  const { data: plans } = await db.from('coop_savings_plans')
    .select('*').eq('member_id', member.id).order('created_at', { ascending: false });

  const plansWithProgress = await Promise.all((plans || []).map(async (plan) => {
    const { data: ledgerRows } = await db.from('coin_ledger')
      .select('amount')
      .eq('new_holder_hash', society.merchant_id)
      .eq('prev_holder_hash', memberHolderHash)
      .gte('changed_at', plan.created_at);
    const savedKobo = (ledgerRows || []).reduce((s, r) => s + (r.amount || 0), 0) + (member.opening_balance_kobo || 0);
    return { ...plan, saved_kobo: savedKobo, progress_pct: Math.min(100, Math.round((savedKobo / plan.target_amount_kobo) * 100)) };
  }));

  const { data: loans } = await db.from('coop_loans')
    .select('*, guarantor:coop_members!coop_loans_guarantor_member_id_fkey(name)')
    .eq('member_id', member.id).order('requested_at', { ascending: false });

  const { data: guarantorRequests } = await db.from('coop_loans')
    .select('id, principal_kobo, repayment_months, monthly_repayment_kobo, requested_at, borrower:coop_members!coop_loans_member_id_fkey(name, phone_normalized)')
    .eq('guarantor_member_id', member.id).eq('status', 'PENDING_GUARANTOR');

  const totalOutstandingLoanKobo = (loans || [])
    .filter(l => ['DISBURSED', 'REPAYING'].includes(l.status))
    .reduce((s, l) => s + (l.principal_kobo || 0), 0);

  return ok({
    is_coop_member:     true,
    society:            { name: society.name },
    member:             { name: member.name, status: member.status },
    savings_plans:      plansWithProgress,
    loans:               loans || [],
    total_outstanding_loan_kobo: totalOutstandingLoanKobo,
    guarantor_requests_pending:  guarantorRequests || [],
  });
};
