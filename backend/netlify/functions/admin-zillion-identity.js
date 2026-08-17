/**
 * zillion/backend/netlify/functions/admin-zillion-identity.js
 *
 * GET /api/v1/admin-zillion-identity?phone=X  (or ?zillion_id=X)
 *
 * Looks up a unified Zillion identity and shows every role (wallet,
 * merchant, agent) linked to it — the actual proof tool for the
 * identity-unification work: if the same phone was used to register
 * as both a wallet user and a merchant, this shows ONE identity with
 * both roles attached, not two disconnected records.
 *
 * Read-only view — any authenticated admin role can use it, same as
 * every other dashboard/lookup endpoint.
 */
'use strict';

const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');

function normalisePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('234')) return '+' + digits;
  if (digits.startsWith('0'))   return '+234' + digits.slice(1);
  return '+' + digits;
}

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ['SUPER_ADMIN','COMPLIANCE','OPERATIONS','SUPPORT','AUDITOR','VIEWER']))
    return err(403, 'Admin access required');

  const q = event.queryStringParameters || {};
  const rawPhone  = (q.phone || '').trim();
  const zillionId = (q.zillion_id || '').trim();

  if (!rawPhone && !zillionId) return err(400, 'Provide phone or zillion_id query parameter');

  const db = getServiceClient();

  let identity;
  if (zillionId) {
    const { data } = await db.from('zillion_identities').select('*').eq('zillion_id', zillionId).maybeSingle();
    identity = data;
  } else {
    const phone = normalisePhone(rawPhone);
    const { data } = await db.from('zillion_identities').select('*').eq('phone_normalized', phone).maybeSingle();
    identity = data;
  }

  if (!identity) return err(404, 'No Zillion identity found for that phone number — they may not have logged into the wallet, registered as a merchant, or been onboarded as an agent yet.');

  const [devicesRes, merchantsRes, agentsRes] = await Promise.all([
    db.from('devices').select('device_hash, status, kyc_tier, registered_at, last_sync').eq('zillion_id', identity.zillion_id),
    db.from('merchants').select('merchant_id, business_name, owner_name, status, registered_at').eq('zillion_id', identity.zillion_id),
    db.from('agents').select('agent_id, name, status, mfb_id, mfb_name, onboarded_at').eq('zillion_id', identity.zillion_id),
  ]);

  const roles = {
    wallet:   devicesRes.data   || [],
    merchant: merchantsRes.data || [],
    agent:    agentsRes.data    || [],
  };
  const roleCount = roles.wallet.length + roles.merchant.length + roles.agent.length;

  return ok({
    identity: {
      zillion_id:       identity.zillion_id,
      phone_normalized: identity.phone_normalized,
      first_seen_as:    identity.first_seen_as,
      created_at:       identity.created_at,
    },
    roles,
    role_count: roleCount,
    is_multi_role: (roles.wallet.length > 0) + (roles.merchant.length > 0) + (roles.agent.length > 0) > 1,
  });
};
