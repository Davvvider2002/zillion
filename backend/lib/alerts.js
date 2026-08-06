/**
 * zillion/backend/lib/alerts.js
 *
 * Shared alert-logging helper. Writes structured alerts to system_alerts
 * instead of leaving problems buried in Netlify function logs where
 * nobody's actively watching. Deliberately fails silently (logs to
 * console but never throws) — an alert-logging failure should never
 * break the actual operation that triggered it.
 *
 * WARNING/CRITICAL alerts also post to Discord (if DISCORD_WEBHOOK_URL
 * is set) so they reach David without him having to open the admin
 * panel. INFO alerts stay admin-panel-only to avoid notification
 * fatigue. The webhook URL lives only in Netlify's environment
 * variables — never hardcoded here or anywhere in the repo.
 */
'use strict';

const SEVERITY_EMOJI = { CRITICAL: '🔴', WARNING: '🟠', INFO: '🟢' };

/**
 * @param {object} db  Supabase client (service role)
 * @param {object} opts
 * @param {'INFO'|'WARNING'|'CRITICAL'} [opts.severity]
 * @param {string} opts.source   which function/subsystem raised it, e.g. 'admin-reconcile-all'
 * @param {string} opts.message  human-readable summary
 * @param {object} [opts.context]  any structured detail (coin_id, holder_hash, drift amount, etc.)
 */
async function logAlert(db, opts) {
  const severity = opts.severity || 'INFO';
  try {
    await db.from('system_alerts').insert({
      severity,
      source:   opts.source,
      message:  opts.message,
      context:  opts.context || {},
    });
  } catch (e) {
    console.error('[logAlert] failed to write alert (non-fatal):', e.message);
  }

  if (severity === 'WARNING' || severity === 'CRITICAL') {
    postToDiscord(severity, opts.source, opts.message, opts.context).then(result => {
      if (!result.sent) console.warn('[logAlert] Discord post did not send:', result.reason);
    });
  }
}

async function postToDiscord(severity, source, message, context) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return { sent: false, reason: 'DISCORD_WEBHOOK_URL is not set in Netlify environment variables' };

  const emoji = SEVERITY_EMOJI[severity] || '⚪';
  const contextStr = context && Object.keys(context).length
    ? '```' + JSON.stringify(context, null, 2).slice(0, 800) + '```'
    : '';

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: `${emoji} ${severity} — ${source}`,
          description: message + (contextStr ? '\n' + contextStr : ''),
          color: severity === 'CRITICAL' ? 0xC0392B : 0xE67E22,
          timestamp: new Date().toISOString(),
        }],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { sent: false, reason: `Discord returned ${res.status}: ${body.slice(0, 300)}` };
    }
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: `Network error calling Discord: ${e.message}` };
  }
}

module.exports = { logAlert, postToDiscord };
