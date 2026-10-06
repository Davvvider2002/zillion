/**
 * zillion/backend/netlify/functions/admin-coop-flutterwave-payouts.js
 *
 * Paying societies the money Zillion holds on their behalf (see lib/coopFlutterwavePayouts.js for the whole design).
 *
 * GET  /api/v1/admin-coop-flutterwave-payouts[?status=PENDING_APPROVAL]   payouts (newest first) with their audit trail, and the safety settings
 * POST { action, ... }
 *   prepare        { coop_id }                                   SUPER_ADMIN / OPERATIONS
 *   approve        { payout_id, totp_code, acknowledge_destination? }   SUPER_ADMIN / COMPLIANCE, never the preparer
 *   reject         { payout_id, reason }                         SUPER_ADMIN / COMPLIANCE
 *   cancel         { payout_id }                                 the preparer, or SUPER_ADMIN
 *   mark_paid      { payout_id, reference, fee_kobo?, totp_code }       record a manual payment (SUPER_ADMIN / COMPLIANCE, never the preparer)
 *   confirm_not_sent { payout_id, note, totp_code }              after checking Flutterwave: nothing was sent, allow a retry
 *   retry          { payout_id, totp_code }                      send an approved payout again
 *   refresh        { payout_id }                                 ask Flutterwave how a processing payout is getting on
 *
 * Anything that approves or moves money demands a FRESH authenticator code from the signed-in admin, even though they are already
 * logged in: a stolen or left-open session must not be enough. The role comes from the admin's own record, not the token, so a
 * demoted admin loses the right at once.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { verifyTOTP }       = require('../../lib/adminTotp');
const P = require('../../lib/coopFlutterwavePayouts');
const { isLiveMode } = require('../../lib/coopFlutterwaveLedger');
const { fetchAllRows, chunk } = require('../../lib/coopPaginate');

const STEP_UP = new Set(['approve', 'mark_paid', 'confirm_not_sent', 'retry']);
const VIEW_ROLES = ['SUPER_ADMIN', 'OPERATIONS', 'COMPLIANCE', 'AUDITOR'];

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });
  if (!['GET', 'POST'].includes(event.httpMethod)) return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  const db = getServiceClient();

  // who is this, really? The admin's own record decides the role.
  const userId = auth.payload && auth.payload.sub;
  const { data: user } = userId ? await db.from('admin_users').select('user_id, username, full_name, role, status, totp_secret, totp_enabled').eq('user_id', userId).maybeSingle() : { data: null };
  if (!user || String(user.status).toUpperCase() !== 'ACTIVE') return err(403, 'Sign in with your own admin account to work with payouts');
  const actor = { id: user.user_id, name: user.full_name || user.username, role: user.role };
  const cfg = P.config();

  try {
    if (event.httpMethod === 'GET') {
      if (!VIEW_ROLES.includes(actor.role)) return err(403, 'Not permitted');
      const status = (event.queryStringParameters || {}).status;
      const payouts = await fetchAllRows(() => { let q = db.from('coop_flutterwave_payouts').select('*'); if (status) q = q.eq('status', status); return q.order('created_at', { ascending: false }).order('id').limit(200); });
      const ids = payouts.map(p => p.id), byPayout = new Map();
      for (const part of chunk(ids)) for (const e of await fetchAllRows(() => db.from('coop_flutterwave_payout_events').select('*').in('payout_id', part).order('created_at').order('id'))) {
        if (!byPayout.has(e.payout_id)) byPayout.set(e.payout_id, []); byPayout.get(e.payout_id).push(e);
      }
      const societies = new Map((await fetchAllRows(() => db.from('coop_societies').select('coop_id, name').order('coop_id'))).map(s => [s.coop_id, s.name]));
      return ok({
        config: { automatic_enabled: cfg.enabled, live_key: isLiveMode(), dual_approval_kobo: cfg.dualApprovalKobo, min_kobo: cfg.minKobo, max_kobo: cfg.maxKobo, daily_limit_kobo: cfg.dailyLimitKobo },
        you: { id: actor.id, role: actor.role, can_prepare: P.PREPARER_ROLES.includes(actor.role), can_approve: P.APPROVER_ROLES.includes(actor.role), totp_enabled: !!(user.totp_enabled && user.totp_secret) },
        payouts: payouts.map(p => ({ ...p, society_name: societies.get(p.coop_id) || p.coop_id, events: byPayout.get(p.id) || [] })),
      });
    }

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return err(400, 'Invalid JSON'); }
    const action = body.action;

    if (STEP_UP.has(action)) {
      if (!(user.totp_enabled && user.totp_secret)) return err(403, 'Turn on your authenticator app first - approving or paying out requires a fresh code');
      if (!verifyTOTP(user.totp_secret, body.totp_code)) return err(401, 'Incorrect or missing authenticator code');
    }
    const id = String(body.payout_id || '');
    let r;
    switch (action) {
      case 'prepare':          r = await P.preparePayout(db, actor, String(body.coop_id || ''), { cfg }); break;
      case 'approve':          r = await P.approvePayout(db, actor, id, { cfg, acknowledgeDestination: body.acknowledge_destination === true }); break;
      case 'reject':           r = await P.rejectPayout(db, actor, id, String(body.reason || '').trim()); break;
      case 'cancel':           r = await P.cancelPayout(db, actor, id); break;
      case 'mark_paid':        r = await P.markPaidManually(db, actor, id, { reference: body.reference, feeKobo: body.fee_kobo }); break;
      case 'confirm_not_sent': r = await P.confirmNotSent(db, actor, id, body.note); break;
      case 'retry':            r = await P.retryPayout(db, actor, id, { cfg }); break;
      case 'refresh':          r = { ok: true, result: await P.refreshPayout(db, id), payout: await P.getPayout(db, id) }; break;
      default: return err(400, 'Unknown action');
    }
    return r.ok === false ? err(r.status || 400, r.error) : ok({ success: true, ...r });
  } catch (e) {
    return err(500, `Payout action failed: ${e.message}`);
  }
};
