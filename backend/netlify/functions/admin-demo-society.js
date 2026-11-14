/**
 * GET /api/v1/admin-demo-society
 * Zillion admin only. Shows the state of the public demo cooperative and the logins to hand out.
 * The build itself runs in admin-demo-society-background.js (it takes minutes).
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const D = require('../../lib/coopDemo');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const reply = (c, b) => ({ statusCode: c, headers: hdr, body: JSON.stringify(b) });
  if (event.httpMethod !== 'GET') return reply(405, { error: 'Method Not Allowed' });
  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return reply(401, { error: 'Authentication required' });
  if (!requireRole(auth, ['SUPER_ADMIN', 'OPERATIONS'])) return reply(403, { error: 'SUPER_ADMIN or OPERATIONS role required' });

  const db = getServiceClient();
  const state = await D.loadState(db);
  const members = D.demoMembers();
  const next = state && state.status === 'ready' && state.built_at
    ? new Date(new Date(state.last_reset_at || state.built_at).getTime() + (state.reset_every_days || D.DEMO.resetEveryDays) * 86400000).toISOString() : null;
  return reply(200, {
    state: state ? { status: state.status, detail: state.status_detail, error: state.last_error, built_at: state.built_at, last_reset_at: state.last_reset_at,
      reset_every_days: state.reset_every_days, next_reset_at: next, log: state.build_log } : { status: 'not_built' },
    logins: {
      society_admin: { site: 'https://zillion.ng/coop-admin/', phone: D.DEMO.adminPhoneLocal, password: D.demoPassword() },
      members: { site: 'https://zillion.ng/wallet/?app=coop', code: D.DEMO_COOP_OTP, note: 'Enter the phone number, tap Send Code (the code fills in by itself), then Verify.',
        phones: members.slice(0, 6).map(m => ({ name: m.name, phone: m.phone })), range: '08000000001 to 08000000024' },
    },
  });
};
