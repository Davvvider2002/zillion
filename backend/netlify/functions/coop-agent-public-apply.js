/**
 * zillion/backend/netlify/functions/coop-agent-public-apply.js
 *
 * POST /api/v1/coop-agent-public-apply
 * Body: { name, phone, email, address?, office_location?, staff_count?, qualifications?, saas_experience? }
 *
 * Public, unauthenticated - the whole point of a recruitment link is that a prospect reaches it with no
 * Zillion account at all. Unlike becoming an Ajo collector, there is no fee here and no payment step - a
 * Coop agent application is pure information capture, gated by Zillion Admin's manual review
 * (admin-coop-agent-applications.js), not by money. Deliberately asks for real business detail (office
 * location, staff count, qualifications, SaaS/software sales experience) rather than just a name and phone,
 * since an agent is being trusted to represent Zillion Coop to real cooperative societies.
 *
 * Does NOT create a zillion_id or a coop_agents row at this point - that only happens on approval
 * (admin-coop-agent-applications.js), same reasoning collector applications follow: a rejected or still-
 * pending applicant shouldn't already exist as an active platform entity.
 */
'use strict';

const { cleanText } = require('../../lib/cleanText');
const { getServiceClient } = require('../../lib/supabase');
const { limitByIp, tooManyRequests } = require('../../lib/publicRateLimit');

function normalisePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('234')) return '+' + digits;
  if (digits.startsWith('0'))   return '+234' + digits.slice(1);
  return '+234' + digits;
}

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const name = cleanText(body.name, 100);
  const rawPhone = (body.phone || '').trim();
  const email = (body.email || '').trim();
  const address = cleanText(body.address, 200) || null;
  const officeLocation = (body.office_location || '').trim() || null;
  const staffCount = Number.isInteger(body.staff_count) ? body.staff_count : (body.staff_count ? parseInt(body.staff_count, 10) : null);
  const qualifications = (body.qualifications || '').trim() || null;
  const saasExperience = (body.saas_experience || '').trim() || null;

  if (!name) return err(400, 'name is required');
  if (!rawPhone) return err(400, 'phone is required');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err(400, 'A valid email is required — this is how you\'ll be notified of the decision');

  const phone = normalisePhone(rawPhone);
  const db = getServiceClient();

  // An applicant who already has an application waiting needs no second one - and nobody needs fifty.
  const { data: pending } = await db.from('coop_agent_applications').select('id').eq('phone', phone).eq('status', 'PENDING').limit(1);
  if (pending && pending.length) return err(409, 'We already have your application and it is waiting for review. Zillion Admin will email you the decision.');
  const ipLimit = await limitByIp(db, event, 'coop-agent-apply', { windowMinutes: 24 * 60, maxAttempts: 5, lockoutMinutes: 24 * 60 });
  if (!ipLimit.allowed) return tooManyRequests(ipLimit.retryAfterSeconds, 'applications');

  const { data: application, error } = await db.from('coop_agent_applications').insert({
    name, phone, email, address, office_location: officeLocation,
    staff_count: (staffCount != null && !isNaN(staffCount)) ? staffCount : null,
    qualifications, saas_experience: saasExperience,
  }).select().single();

  if (error) return err(500, `Failed to submit application: ${error.message}`);

  return ok({ success: true, application_id: application.id, message: 'Application submitted. Zillion Admin will review it and email you the decision.' });
};
