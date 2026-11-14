/**
 * Runs daily (netlify.toml). Puts the demo cooperative back to its baseline once resetEveryDays have passed since the last
 * reset, so whatever visitors typed in is cleared. Does nothing until the demo has been built.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { logAlert } = require('../../lib/alerts');
const D = require('../../lib/coopDemo');
const { resetDemoSociety } = require('../../lib/coopDemoBuild');

exports.handler = async () => {
  const db = getServiceClient();
  const state = await D.loadState(db);
  if (!D.resetDue(state)) return { statusCode: 200, body: JSON.stringify({ reset: false }) };
  const r = await resetDemoSociety(db, { actor: 'scheduled-demo-reset' });
  if (!r.ok) await logAlert(db, { source: 'scheduled-demo-reset', severity: 'WARNING', message: 'The demo cooperative could not be reset: ' + r.error });
  return { statusCode: 200, body: JSON.stringify({ reset: r.ok, error: r.error || null }) };
};
