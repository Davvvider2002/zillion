/**
 * zillion/backend/netlify/functions/coop-portal-go-live-template.js
 *
 * GET /api/v1/coop-portal-go-live-template[?dataset=members]
 *
 * The go-live sheets as downloadable CSV templates: one named sheet, or all six in loading order. Each comes with its
 * column guide so the portal can show what every column means.
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');
const { ORDER, buildTemplate } = require('../../lib/coopGoLiveImport');
const { ensureChartOfAccounts } = require('../../lib/coopAccounting');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');
  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');

  const db = getServiceClient();
  const resolved = await resolvePortalSociety(db, auth);
  if (!resolved.ok) return err(resolved.status, resolved.error);
  if (!(await requirePortalPermission(db, auth, 'members', 'create'))) {
    return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');
  }

  // The two accounting sheets are filled with the society's own account codes, so the list comes with them.
  const withAccounts = async t => {
    if (!t || !['opening_balances', 'society_entries'].includes(t.dataset)) return t;
    await ensureChartOfAccounts(db, resolved.society.coop_id, resolved.society.base_currency || 'NGN');
    const { data } = await db.from('coop_chart_of_accounts').select('account_code, account_name, account_type, sub_type')
      .eq('coop_id', resolved.society.coop_id).eq('active', true).order('account_code');
    return { ...t, accounts: data || [] };
  };

  const one = (event.queryStringParameters || {}).dataset;
  if (one) {
    const t = buildTemplate(one);
    if (!t) return err(400, `dataset must be one of: ${ORDER.join(', ')}`);
    return ok({ success: true, template: await withAccounts(t) });
  }
  return ok({ success: true, order: ORDER, templates: await Promise.all(ORDER.map(k => withAccounts(buildTemplate(k)))) });
};
