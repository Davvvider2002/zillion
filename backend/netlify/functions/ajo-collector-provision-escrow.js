/**
 * zillion/backend/netlify/functions/ajo-collector-provision-escrow.js
 *
 * POST /api/v1/ajo-collector-provision-escrow
 * Body: { first_name, last_name, nin, phone, email? }
 *
 * A collector's own self-service step: submit KYC to open their
 * platform-wide escrow wallet. Attempts the real Wema Wallet Creation
 * API call first (see backend/lib/wemaEscrow.js) - if that's not yet
 * configured (the honest current state - no live Wema partnership
 * exists yet), this falls into PENDING_VERIFICATION rather than
 * failing outright, so the collector's submission is captured and a
 * platform admin can manually confirm it via
 * ajo-admin-verify-collector-escrow.js in the meantime. The moment
 * Wema credentials exist, this same endpoint starts completing
 * automatically - no change needed here, only in wemaEscrow.js.
 *
 * Deliberately does NOT store the raw NIN anywhere - it's used only
 * to make the (eventual) Wema API call, matching the same pattern
 * already established for BVN/NIN in ajo-member-provision-account.js
 * elsewhere in this codebase. Only the resulting account details get
 * persisted.
 *
 * Auth: wallet JWT (zillion_id).
 */
'use strict';

const { getServiceClient }  = require('../../lib/supabase');
const { verifyJWT }         = require('../../lib/validators');
const { createEscrowWallet } = require('../../lib/wemaEscrow');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  const zillionId = auth.payload.zillion_id;
  if (!zillionId) return err(400, 'No zillion_id on this token — sign in through the wallet first');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const firstName = (body.first_name || '').trim();
  const lastName  = (body.last_name || '').trim();
  const nin       = (body.nin || '').trim();
  const phone     = (body.phone || '').trim();
  const email     = (body.email || '').trim() || null;

  if (!firstName) return err(400, 'first_name is required');
  if (!lastName)  return err(400, 'last_name is required');
  if (!/^\d{11}$/.test(nin)) return err(400, 'nin must be an 11-digit number');
  if (!phone) return err(400, 'phone is required');

  const db = getServiceClient();

  let { data: profile } = await db.from('ajo_collector_profiles').select('*').eq('zillion_id', zillionId).maybeSingle();
  if (!profile) {
    const { data: created, error: createErr } = await db.from('ajo_collector_profiles').insert({ zillion_id: zillionId }).select().single();
    if (createErr) return err(500, `Failed to create collector profile: ${createErr.message}`);
    profile = created;
  }

  if (profile.delisted_at) return err(403, `You were delisted as a collector (${profile.delisted_reason || 'compliance threshold'}) and cannot re-provision escrow. Contact support.`);
  if (profile.escrow_status === 'ACTIVE') return ok({ success: true, already_verified: true, message: 'Your escrow wallet is already verified and active.' });

  const walletResult = await createEscrowWallet({ firstName, lastName, nin, phone, email });

  if (walletResult.ok) {
    // Real Wema integration path - not reachable today, but the
    // full shape is here for the moment credentials exist.
    const { data: updated, error: updateErr } = await db.from('ajo_collector_profiles').update({
      escrow_status: 'ACTIVE', escrow_wallet_id: walletResult.walletId,
      escrow_account_number: walletResult.accountNumber, escrow_account_name: walletResult.accountName,
      escrow_verified_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq('id', profile.id).select().single();
    if (updateErr) return err(500, `Wallet created but failed to save: ${updateErr.message}`);

    await db.from('ajo_collectors').update({ status: 'ACTIVE' }).eq('collector_profile_id', profile.id).eq('status', 'PENDING_ESCROW');

    return ok({ success: true, escrow_status: 'ACTIVE', profile: updated, message: 'Escrow wallet verified and active. You can now start collecting on any scheme you have been assigned to.' });
  }

  // Wema not yet configured (the honest current state) - queue for
  // manual admin verification instead of failing the submission.
  const { data: updated, error: updateErr } = await db.from('ajo_collector_profiles').update({
    escrow_status: 'PENDING_VERIFICATION', escrow_account_name: `${firstName} ${lastName}`,
    updated_at: new Date().toISOString(),
  }).eq('id', profile.id).select().single();
  if (updateErr) return err(500, `Failed to submit for verification: ${updateErr.message}`);

  return ok({
    success: true, escrow_status: 'PENDING_VERIFICATION', profile: updated,
    message: 'Your details have been submitted. A platform admin will confirm your escrow account before you can start collecting.',
  });
};
