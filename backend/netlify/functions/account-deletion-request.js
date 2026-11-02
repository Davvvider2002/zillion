/**
 * POST /api/v1/account-deletion-request
 * Public. Lets anyone ask for their Zillion Coop account (or only their data) to be deleted. Powers the page at
 * zillion.ng/delete-account that Google Play requires.
 *
 * Nothing is deleted here. The request is stored, support is told, and staff confirm the person by calling the
 * registered number before acting (SMS is not always available, and a stranger must never be able to delete a
 * member's account by typing their number). The reply is identical whether or not the number belongs to a member, so
 * the form cannot be used to find out who is registered.
 *
 * Body: { phone, full_name, email?, scope: 'account' | 'data_only', reason?, website? }
 * `website` is a honeypot: real people never see or fill it.
 */
'use strict';

const { createHash } = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { checkRateLimit } = require('../../lib/rateLimit');
const { sendEmail } = require('../../lib/resendEmail');

const SUPPORT_EMAIL = 'support@zillion.ng';
const SAME_REPLY = 'Your request has been received. We will contact you on the phone number you gave to confirm it is you. Nothing is deleted until we do.';

function normalise(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('234')) return '+' + d;
  if (d.startsWith('0')) return '+234' + d.slice(1);
  return d ? '+234' + d : '';
}
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok = b => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c, m) => ({ statusCode: c, headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return err(400, 'Invalid request'); }

  // Honeypot: pretend success so bots learn nothing.
  if (body.website) return ok({ success: true, message: SAME_REPLY });

  const phone = normalise(body.phone);
  if (!/^\+234\d{10}$/.test(phone)) return err(400, 'Enter the 11 digit phone number you use on Zillion Coop, like 08012345678.');
  const fullName = String(body.full_name || '').trim().replace(/\s+/g, ' ');
  if (fullName.length < 2 || fullName.length > 120) return err(400, 'Enter your full name.');
  const email = String(body.email || '').trim().toLowerCase();
  if (email && (email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return err(400, 'That email address does not look right.');
  const scope = body.scope === 'data_only' ? 'data_only' : 'account';
  const reason = String(body.reason || '').trim().slice(0, 500) || null;

  let db;
  try {
    db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  } catch (e) { return err(500, 'Service unavailable. Please email ' + SUPPORT_EMAIL); }

  const ip = (event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown').split(',')[0].trim();
  if (ip !== 'unknown') {
    const lim = await checkRateLimit(db, `account-deletion:${ip}`, { windowMinutes: 60, maxAttempts: 5, lockoutMinutes: 60 });
    if (!lim.allowed) return err(429, 'Too many requests from this network. Please try again later or email ' + SUPPORT_EMAIL);
  }

  // One open request per number is enough.
  const { data: existing } = await db.from('account_deletion_requests')
    .select('id').eq('phone', phone).in('status', ['pending', 'verified']).limit(1);
  if (existing && existing.length) return ok({ success: true, message: SAME_REPLY });

  const ipHash = ip === 'unknown' ? null : createHash('sha256').update(ip + (process.env.OTP_SECRET || '')).digest('hex').slice(0, 24);
  const { data: row, error } = await db.from('account_deletion_requests')
    .insert({ phone, full_name: fullName, email: email || null, scope, reason, ip_hash: ipHash })
    .select('id').single();
  if (error) {
    console.error('[account-deletion-request] insert failed:', error.message);
    return err(500, 'We could not save your request. Please email ' + SUPPORT_EMAIL + ' instead.');
  }

  const what = scope === 'data_only' ? 'delete some of my data, keep my account' : 'delete my account and data';
  try {
    await sendEmail({
      to: SUPPORT_EMAIL, subject: 'Account deletion request: ' + phone,
      htmlContent: `<p>New request (${esc(row.id)}).</p><p><b>${esc(fullName)}</b>, ${esc(phone)}${email ? ', ' + esc(email) : ''}</p><p>Wants to: ${esc(what)}</p><p>Reason: ${esc(reason || 'none given')}</p><p>Call the registered number to confirm identity before acting, then update the row in account_deletion_requests.</p>`,
    });
    if (email) {
      await sendEmail({
        to: email, toName: fullName, subject: 'We received your Zillion Coop deletion request',
        htmlContent: `<p>Hello ${esc(fullName)},</p><p>We received your request to ${esc(what)}. For your safety we will call ${esc(phone)} to confirm it is you. Nothing is deleted until we do.</p><p>If you did not make this request, ignore this email or write to ${SUPPORT_EMAIL}.</p><p>Zillion Coop</p>`,
      });
    }
  } catch (e) { console.warn('[account-deletion-request] email failed (non-fatal):', e.message); }

  return ok({ success: true, message: SAME_REPLY });
};
