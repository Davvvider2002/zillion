/**
 * GET /api/v1/admin-fraud
 * Returns fraud events list + summary for admin dashboard.
 * Admin JWT required.
 */
'use strict';
const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b    => ({ statusCode:200, headers:hdr, body:JSON.stringify(b) });
  const err = (c,m)=> ({ statusCode:c,   headers:hdr, body:JSON.stringify({error:m}) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');
  const auth = verifyJWT(event.headers.authorization||event.headers.Authorization||'');
  if (!auth.valid || auth.payload.role !== 'admin') return err(401, 'Admin access required');

  try {
    const db = getServiceClient();
    const p  = event.queryStringParameters || {};
    const limit  = Math.min(parseInt(p.limit||100), 500);
    const offset = parseInt(p.offset||0);
    const resolved = p.resolved === 'true' ? true : p.resolved === 'false' ? false : null;

    // Fetch fraud events
    let q = db.from('fraud_events')
      .select('*', { count:'exact' })
      .order('detected_at', { ascending:false })
      .range(offset, offset+limit-1);
    if (resolved !== null) q = q.eq('resolved', resolved);
    const { data:events, count, error } = await q;
    if (error) throw error;

    // Summary counts
    const { count:openCount }     = await db.from('fraud_events').select('*',{count:'exact',head:true}).eq('resolved',false);
    const { count:resolvedCount } = await db.from('fraud_events').select('*',{count:'exact',head:true}).eq('resolved',true);
    const { count:totalCount }    = await db.from('fraud_events').select('*',{count:'exact',head:true});

    // Enrich events with coin info where available
    const enriched = await Promise.all((events||[]).map(async ev => {
      let coinInfo = null;
      if (ev.coin_id) {
        const { data:coin } = await db.from('coins').select('coin_id,status,amount,issuer_id,holder_hash')
          .eq('coin_id', ev.coin_id).single();
        coinInfo = coin || null;
      }
      return { ...ev, coin: coinInfo };
    }));

    return ok({
      success: true,
      events:  enriched,
      total:   count || 0,
      limit, offset,
      summary: {
        open:     openCount     || 0,
        resolved: resolvedCount || 0,
        total:    totalCount    || 0,
      },
      generated_at: new Date().toISOString(),
    });
  } catch(e) {
    return err(500, e.message);
  }
};
