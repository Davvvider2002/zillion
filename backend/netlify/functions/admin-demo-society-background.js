/**
 * POST /.netlify/functions/admin-demo-society-background   Body: { action: 'build' | 'reset' }
 * A Netlify BACKGROUND function (the -background suffix): it answers 202 at once and may run for up to 15 minutes, which a
 * full build needs. Progress is written to demo_society_state, and the admin page polls admin-demo-society for it.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { buildDemoSociety, resetDemoSociety } = require('../../lib/coopDemoBuild');
const D = require('../../lib/coopDemo');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405 };
  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid || !requireRole(auth, ['SUPER_ADMIN', 'OPERATIONS'])) return { statusCode: 403 };
  let body = {}; try { body = JSON.parse(event.body || '{}'); } catch (_) { /* default */ }
  const db = getServiceClient();
  const actor = auth.payload.username || auth.payload.sub || 'admin';
  const state = await D.loadState(db);
  if (state && state.status === 'building' && state.updated_at && Date.now() - new Date(state.updated_at).getTime() < 20 * 60000) return { statusCode: 409 };
  if (body.action === 'reset') await resetDemoSociety(db, { actor });
  else await buildDemoSociety(db, { actor });
  return { statusCode: 200 };
};
