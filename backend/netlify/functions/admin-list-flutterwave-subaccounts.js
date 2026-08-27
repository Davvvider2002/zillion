/**
 * zillion/backend/netlify/functions/admin-list-flutterwave-subaccounts.js
 *
 * GET /api/v1/admin-list-flutterwave-subaccounts
 *
 * Read-only diagnostic: lists every subaccount that actually exists on
 * Flutterwave's side. Built specifically to answer a real question —
 * "already exists" on a settlement-account attempt means something is
 * registered on Flutterwave for that bank + account number, but our
 * own database might not know about it (e.g. an earlier attempt that
 * created the subaccount on Flutterwave's side successfully, then
 * failed to save locally due to a since-fixed bug). This lets that be
 * confirmed directly rather than guessed at.
 *
 * Auth: SUPER_ADMIN or OPERATIONS. GET only, makes no changes anywhere.
 */
'use strict';

const { verifyJWT, requireRole } = require('../../lib/validators');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ['SUPER_ADMIN', 'OPERATIONS']))
    return err(403, 'SUPER_ADMIN or OPERATIONS role required');

  const secretKey = (process.env.FLW_V3_SECRET_KEY || '').trim();
  if (!secretKey) return err(500, 'FLW_V3_SECRET_KEY not configured');

  try {
    const res = await fetch('https://api.flutterwave.com/v3/subaccounts', {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    const flwData = await res.json();
    if (flwData.status !== 'success') return err(502, `Flutterwave rejected the subaccounts request: ${flwData.message || 'unknown error'}`);

    const subaccounts = (flwData.data || []).map(s => ({
      id: s.id,
      subaccount_id: s.subaccount_id,
      account_number: s.account_number,
      account_bank: s.account_bank,
      full_name: s.full_name,
      business_name: s.business_name,
      created_at: s.created_at,
    }));

    return ok({ count: subaccounts.length, subaccounts });
  } catch (e) {
    return err(502, `Failed to reach Flutterwave: ${e.message}`);
  }
};
