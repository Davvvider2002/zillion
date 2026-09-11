/**
 * zillion/backend/netlify/functions/admin-zillion-ledger.js
 *
 * GET /api/v1/admin-zillion-ledger
 *
 * Trial balance for Zillion's own platform-level books - every
 * account's total debits, credits, and net balance, computed live
 * from zillion_journal_entry_lines (never a separately-stored,
 * potentially-drifting figure). Makes the gross/discount/net revenue
 * split genuinely visible: Subscription Income shows the full,
 * undiscounted value recognized; Discount Allowed shows exactly how
 * much was given away on yearly plans; the difference between them is
 * the real net revenue - not something anyone has to compute by hand.
 *
 * Auth: SUPER_ADMIN or OPERATIONS.
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
  if (!requireRole(auth, ['SUPER_ADMIN', 'OPERATIONS'])) return err(403, 'SUPER_ADMIN or OPERATIONS required');

  const db = getServiceClient();

  const { data: accounts } = await db.from('zillion_chart_of_accounts').select('*').order('account_code');
  const { data: lines } = await db.from('zillion_journal_entry_lines').select('account_id, line_type, amount');

  const byAccount = new Map();
  for (const a of (accounts || [])) byAccount.set(a.id, { ...a, debit_total_kobo: 0, credit_total_kobo: 0 });
  for (const l of (lines || [])) {
    const acc = byAccount.get(l.account_id);
    if (!acc) continue;
    if (l.line_type === 'debit') acc.debit_total_kobo += l.amount;
    else acc.credit_total_kobo += l.amount;
  }

  const rows = Array.from(byAccount.values()).map(a => ({
    account_code: a.account_code, account_name: a.account_name, account_type: a.account_type,
    debit_total_kobo: a.debit_total_kobo, credit_total_kobo: a.credit_total_kobo,
    net_balance_kobo: a.debit_total_kobo - a.credit_total_kobo,
  }));

  const income = rows.find(r => r.account_code === '4000');
  const discount = rows.find(r => r.account_code === '5000');
  const grossIncomeKobo = income ? income.credit_total_kobo : 0;
  const discountKobo = discount ? discount.debit_total_kobo : 0;

  return ok({
    accounts: rows,
    summary: {
      gross_subscription_income_kobo: grossIncomeKobo,
      discount_allowed_kobo: discountKobo,
      net_subscription_income_kobo: grossIncomeKobo - discountKobo,
    },
  });
};
