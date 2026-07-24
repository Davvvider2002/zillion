'use strict';
/**
 * GET /api/v1/admin/commission-events
 * Query params: agent_id, mfb_id, txn_type, from, to, status, limit (max 500)
 * Returns commission events with totals.
 */

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const err = (c,m) => ({ statusCode:c, headers:hdr, body:JSON.stringify({error:m}) });

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid || auth.payload.role !== 'admin') return err(401,'Admin auth required');

  const q    = event.queryStringParameters || {};
  const db   = getServiceClient();
  const lim  = Math.min(parseInt(q.limit)||100, 500);

  let query = db.from('commission_events').select('*').order('created_at',{ascending:false}).limit(lim);
  if (q.agent_id)  query = query.eq('agent_id',  q.agent_id);
  if (q.mfb_id)    query = query.eq('mfb_id',    q.mfb_id);
  if (q.txn_type)  query = query.eq('txn_type',  q.txn_type);
  if (q.status)    query = query.eq('status',    q.status);
  if (q.from)      query = query.gte('created_at', q.from);
  if (q.to)        query = query.lte('created_at', q.to);

  const { data, error } = await query;
  if (error) return { statusCode:500, headers:hdr, body:JSON.stringify({error:error.message}) };

  const events = data || [];
  const totals = events.reduce((acc, e) => {
    acc.fee_kobo      += e.fee_kobo      || 0;
    acc.mfb_kobo      += e.mfb_kobo      || 0;
    acc.zillion_kobo  += e.zillion_kobo  || 0;
    acc.agent_kobo    += e.agent_kobo    || 0;
    acc.txn_count++;
    return acc;
  }, { fee_kobo:0, mfb_kobo:0, zillion_kobo:0, agent_kobo:0, txn_count:0 });

  return { statusCode:200, headers:hdr,
    body: JSON.stringify({ events, totals, count: events.length }) };
};
