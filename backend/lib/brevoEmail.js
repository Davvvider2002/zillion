/**
 * zillion/backend/lib/brevoEmail.js
 *
 * Shared helper for sending transactional email via Brevo's API.
 * Confirmed directly against Brevo's own docs before building this:
 * POST https://api.brevo.com/v3/smtp/email, authenticated via an
 * api-key header (not Bearer), sender must be a pre-verified address
 * in the Brevo dashboard or every send fails.
 *
 * Silent no-op if BREVO_API_KEY isn't configured yet — email is an
 * enhancement over the existing Discord alerting, not a replacement,
 * so nothing that currently works should start failing just because
 * this hasn't been set up yet.
 */
'use strict';

async function sendEmail({ to, toName, subject, htmlContent }) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  if (!apiKey || !senderEmail) {
    console.warn('[brevoEmail] BREVO_API_KEY or BREVO_SENDER_EMAIL not configured — skipping email send');
    return { sent: false, reason: 'not_configured' };
  }

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: 'Zillion Coop', email: senderEmail },
        to: [{ email: to, name: toName || undefined }],
        subject,
        htmlContent,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('[brevoEmail] Send failed:', data.message || res.status);
      return { sent: false, reason: data.message || 'send_failed' };
    }
    return { sent: true, messageId: data.messageId };
  } catch (e) {
    console.error('[brevoEmail] Non-fatal error:', e.message);
    return { sent: false, reason: 'unexpected_error' };
  }
}

module.exports = { sendEmail };
