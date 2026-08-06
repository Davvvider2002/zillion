/**
 * zillion/backend/lib/alerts.js
 *
 * Shared alert-logging helper. Writes structured alerts to system_alerts
 * instead of leaving problems buried in Netlify function logs where
 * nobody's actively watching. Deliberately fails silently (logs to
 * console but never throws) — an alert-logging failure should never
 * break the actual operation that triggered it.
 */
'use strict';

/**
 * @param {object} db  Supabase client (service role)
 * @param {object} opts
 * @param {'INFO'|'WARNING'|'CRITICAL'} [opts.severity]
 * @param {string} opts.source   which function/subsystem raised it, e.g. 'admin-reconcile-all'
 * @param {string} opts.message  human-readable summary
 * @param {object} [opts.context]  any structured detail (coin_id, holder_hash, drift amount, etc.)
 */
async function logAlert(db, opts) {
  try {
    await db.from('system_alerts').insert({
      severity: opts.severity || 'INFO',
      source:   opts.source,
      message:  opts.message,
      context:  opts.context || {},
    });
  } catch (e) {
    console.error('[logAlert] failed to write alert (non-fatal):', e.message);
  }
}

module.exports = { logAlert };
