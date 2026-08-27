/**
 * zillion/backend/netlify/functions/coop-member-activity.js
 *
 * GET /api/v1/coop-member-activity
 *
 * The coop-flavored wallet's History screen shows Zil coin transfers
 * by default, which is meaningless for a cooperative member whose
 * real activity is savings and dues payments (a separate ledger from
 * Zil coins entirely). This merges both into one chronological list
 * so History shows something actually relevant to a coop member.
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

  const activity = [
    ...(savingsTxns || []).map(t => ({ type: 'savings', amount_kobo: t.amount_kobo, source: t.source, ts: t.created_at })),
    ...(duesTxns || []).map(t => ({ type: 'dues', amount_kobo: t.amount_kobo, source: t.source, ts: t.created_at })),
  ].sort((a, b) => new Date(b.ts) - new Date(a.ts));

  return ok({ is_coop_member: true, activity });
};
