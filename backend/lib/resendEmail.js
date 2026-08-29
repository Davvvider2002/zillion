/**
 * zillion/backend/lib/resendEmail.js
 *
 * Shared helper for sending transactional email via Resend's API.
 * Replaces brevoEmail.js — Brevo's mandatory IP-verification step
 * doesn't work with Netlify Functions' rotating outbound IPs (a large
 * shared AWS pool with no fixed address on anything short of an
 * Enterprise-only add-on), and kept blocking legitimate sends from
 * new/unrecognized IPs regardless of Brevo's own "IP blocking" toggle
 * being off. Confirmed against Resend's own docs before switching:
 * pure API-key auth, no IP allowlisting requirement at all.
 *
 * POST https://api.resend.com/emails, Bearer-token auth. Sender must
 * be a verified domain in the Resend dashboard for production use —
 * `onboarding@resend.dev` works immediately with zero verification
 * for testing, which is what RESEND_SENDER_EMAIL should be set to
 * until a real domain is verified there.
 *
 * Silent no-op if RESEND_API_KEY isn't configured yet — same as the
 * Brevo version, an enhancement over existing alerting, not a
 * replacement, so nothing that currently works should start failing
 * just because this hasn't been set up.
 */
'use strict';

async function sendEmail({ to, toName, subject, htmlContent, attachments }) {
  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  const senderEmail = (process.env.RESEND_SENDER_EMAIL || '').trim();
  if (!apiKey || !senderEmail) {
    console.warn('[resendEmail] RESEND_API_KEY or RESEND_SENDER_EMAIL not configured — skipping email send');
    return { sent: false, reason: 'not_configured' };
  }

  try {
    const payload = {
      from: `Zillion Coop <${senderEmail}>`,
      to: [toName ? `${toName} <${to}>` : to],
      subject,
      html: htmlContent,
    };
    // attachments: [{ filename, content }] — content is base64, matching
    // Resend's confirmed attachment format (verified against their docs
    // before this was added, not assumed).
    if (attachments && attachments.length) payload.attachments = attachments;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('[resendEmail] Send failed:', data.message || res.status);
      return { sent: false, reason: data.message || 'send_failed' };
    }
    return { sent: true, messageId: data.id };
  } catch (e) {
    console.error('[resendEmail] Non-fatal error:', e.message);
    return { sent: false, reason: 'unexpected_error' };
  }
}

module.exports = { sendEmail };
