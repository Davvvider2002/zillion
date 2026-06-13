/**
 * GET /api/v1/agent-statement
 * Returns agent's full financial statement:
 * opening balance, all transactions, running balance, closing balance
 */
'use strict';
const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode:405, body:JSON.stringify({error:'Method Not Allowed'}) };
  }
  const auth = verifyJWT(event.headers.authorization||event.headers.Authorization||'');
  if (!auth.valid) return { statusCode:401, body:JSON.stringify({error:auth.reason}) };

  const agent_id = event.queryStringParameters?.agent_id;
  const date_from = event.queryStringParameters?.date_from;
  const date_to   = event.queryStringParameters?.date_to;

  if (!agent_id) return { statusCode:400, body:JSON.stringify({error:'agent_id required'}) };
  if (auth.payload.agent_id !== agent_id) return { statusCode:403, body:JSON.stringify({error:'Forbidden'}) };

  try {
    const db = getServiceClient();

    // Get agent profile
    const { data:agent } = await db.from('agents')
      .select('agent_id,name,phone,location_name,float_balance_kobo,status')
      .eq('agent_id', agent_id).single();
    if (!agent) return { statusCode:404, body:JSON.stringify({error:'Agent not found'}) };

    // Get all transactions involving this agent
    // Cash-ins: coins issued to customers (agent float debited)
    const { data:issued } = await db.from('coins')
      .select('coin_id,amount,issued_at,holder_hash,status')
      .eq('issuer_id', agent_id)
      .order('issued_at', { ascending:true });

    // Cash-outs: coins redeemed through this agent
    const { data:redeemed } = await db.from('coins')
      .select('coin_id,amount,updated_at,holder_hash,status')
      .eq('holder_hash', agent_id)
      .eq('status', 'REDEEMED')
      .order('updated_at', { ascending:true });

    // Build unified transaction list
    const txns = [];

    (issued||[]).forEach(c => {
      txns.push({
        tx_id:   c.coin_id,
        type:    'CASH_IN',
        label:   'Coins Issued to Customer',
        amount:  c.amount,
        debit:   c.amount,
        credit:  0,
        ts:      c.issued_at,
        coin_id: c.coin_id,
        status:  c.status,
      });
    });

    (redeemed||[]).forEach(c => {
      txns.push({
        tx_id:   c.coin_id + '-RDM',
        type:    'CASH_OUT',
        label:   'Customer Redemption',
        amount:  c.amount,
        debit:   0,
        credit:  c.amount,
        ts:      c.updated_at,
        coin_id: c.coin_id,
        status:  'REDEEMED',
      });
    });

    // Sort by timestamp
    txns.sort((a,b) => new Date(a.ts) - new Date(b.ts));

    // Calculate running balance
    // Opening balance = current float + net of all txns reversed
    const totalDebits  = txns.reduce((s,t)=>s+t.debit,0);
    const totalCredits = txns.reduce((s,t)=>s+t.credit,0);
    const openingBalance = agent.float_balance_kobo + totalDebits - totalCredits;

    let runningBalance = openingBalance;
    const txnsWithBalance = txns.map(t => {
      runningBalance = runningBalance - t.debit + t.credit;
      return { ...t, balance_after: runningBalance };
    });

    const summary = {
      opening_balance_kobo: openingBalance,
      total_cash_in_kobo:   totalDebits,
      total_cash_out_kobo:  totalCredits,
      closing_balance_kobo: agent.float_balance_kobo,
      transaction_count:    txns.length,
      cash_in_count:        txns.filter(t=>t.type==='CASH_IN').length,
      cash_out_count:       txns.filter(t=>t.type==='CASH_OUT').length,
    };

    return {
      statusCode:200,
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        success:true, agent, summary,
        transactions: txnsWithBalance,
        generated_at: new Date().toISOString(),
      }),
    };
  } catch(err) {
    return { statusCode:500, body:JSON.stringify({error:err.message}) };
  }
};
