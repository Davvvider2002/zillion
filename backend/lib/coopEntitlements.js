/**
 * zillion/backend/lib/coopEntitlements.js
 *
 * Foundation for real feature-gating. Deliberately thin right now:
 * per the audit behind this build, almost none of the tier-differentiated
 * features on the pricing page exist as actual software yet, and bulk
 * CSV import — the one that does exist — was explicitly kept open to
 * every tier rather than gated. So today this only tracks add-on
 * ownership. As real gated features get built (Accounting, Payroll,
 * Communication Hub), their endpoints call hasAddon() here rather than
 * querying coop_society_addons directly, so the check stays in one
 * place.
 */
'use strict';

async function hasAddon(db, coopId, addonKey) {
  const { data } = await db.from('coop_society_addons')
    .select('id').eq('coop_id', coopId).eq('addon_key', addonKey).maybeSingle();
  return !!data;
}

async function listAddons(db, coopId) {
  const { data } = await db.from('coop_society_addons')
    .select('addon_key, added_at, coop_addon_modules(name, description)')
    .eq('coop_id', coopId);
  return data || [];
}

module.exports = { hasAddon, listAddons };
