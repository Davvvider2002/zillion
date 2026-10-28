/**
 * zillion/backend/lib/coopMemberEvents.js
 *
 * One place that records everything that happens on a member's account, and writes the message about it.
 *
 *  - The event row keeps the message text, ready to send. The member sees it in the app (a matching coop_notifications row
 *    is created for them), and the society's WhatsApp outbox works through the rows still marked pending.
 *  - There is no WhatsApp Business account or third party. A person taps Send on a normal WhatsApp chat that the portal
 *    opens with this text filled in (whatsappUrl below).
 *  - Recording an event must never break the action it describes, so recordMemberEvent never throws.
 *  - Go-live imports are back-dated bulk loads. They never produce events: pass skip: true.
 */
'use strict';

const KINDS = {
  savings_deposit:    { title: 'Savings deposit received' },
  savings_withdrawal: { title: 'Savings withdrawal' },
  dues_paid:          { title: 'Dues payment received' },
  share_purchase:     { title: 'Share purchase recorded' },
  share_withdrawal:   { title: 'Share withdrawal recorded' },
  loan_repayment:     { title: 'Loan repayment received' },
  loan_disbursed:     { title: 'Loan paid out' },
  loan_approved:      { title: 'Loan approved' },
  loan_rejected:      { title: 'Loan application update' },
  dividend_paid:      { title: 'Dividend paid' },
  profile_updated:    { title: 'Your details were updated' },
  status_changed:     { title: 'Membership status changed' },
  member_activated:   { title: 'Welcome' },
};

function naira(kobo) {
  const n = Number(kobo) / 100;
  return '₦' + n.toLocaleString('en-NG', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
}
function niceDate(d) {
  const x = d ? new Date(d) : new Date();
  return x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Lagos' });
}
const firstName = name => String(name || '').trim().split(/\s+/)[0] || 'Member';

/** The message text for one event. Short, plain, and safe to send to a chat: amounts, never a full account picture. */
function buildMessage(kind, o = {}) {
  const soc = o.societyName || 'Your society';
  const hi = `Hello ${firstName(o.memberName)}, ${soc}:`;
  const amt = o.amountKobo != null ? naira(o.amountKobo) : '';
  const day = niceDate(o.date);
  const bal = o.balanceKobo != null ? ` Balance ${naira(o.balanceKobo)}.` : '';
  const ref = o.reference ? ` Ref: ${o.reference}.` : '';
  const tail = ' Contact the office if anything looks wrong.';
  switch (kind) {
    case 'savings_deposit':    return `${hi} ${amt} savings deposit received on ${day}.${bal}${ref}`;
    case 'savings_withdrawal': return `${hi} ${amt} savings withdrawal recorded on ${day}.${bal}${ref}${tail}`;
    case 'dues_paid':          return `${hi} ${amt} dues payment received on ${day}.${ref}`;
    case 'share_purchase':     return `${hi} ${amt} share purchase recorded on ${day}.${ref}`;
    case 'share_withdrawal':   return `${hi} ${amt} share withdrawal recorded on ${day}.${ref}${tail}`;
    case 'loan_repayment':     return `${hi} ${amt} loan repayment received on ${day}.${o.remainingKobo != null ? ` Remaining on this loan ${naira(o.remainingKobo)}.` : ''}${ref}`;
    case 'loan_disbursed':     return `${hi} your loan of ${amt} was paid out on ${day}.${ref}`;
    case 'loan_approved':      return `${hi} your loan of ${amt} has been approved.${o.note ? ' ' + o.note : ''}`;
    case 'loan_rejected':      return `${hi} your loan application was not approved.${o.note ? ' Reason: ' + o.note : ''} Contact the office for details.`;
    case 'dividend_paid':      return `${hi} dividend of ${amt} paid${o.note ? ' ' + o.note : ''} on ${day}.${ref}`;
    case 'profile_updated':    return `${hi} your member details were updated by the society office on ${day}.${tail}`;
    case 'status_changed':     return `${hi} your membership status is now ${o.note || 'updated'}.${tail}`;
    case 'member_activated':   return `${hi} welcome. Your member account is now active.`;
    default:                   return `${hi} there is an update on your account.`;
  }
}

/** International digits for a wa.me link: 08031234567 or +2348031234567 become 2348031234567. */
function waPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('234')) return d;
  if (d.startsWith('0')) return '234' + d.slice(1);
  return d.length === 10 ? '234' + d : d;
}
/** The link that opens a normal WhatsApp chat with the text filled in. A person still taps Send. */
function whatsappUrl(phone, text) {
  const p = waPhone(phone);
  return p ? `https://wa.me/${p}?text=${encodeURIComponent(text)}` : null;
}

/**
 * @param {object} db
 * @param {object} ev  { coopId, memberId, kind, amountKobo?, reference?, note?, balanceKobo?, remainingKobo?, date?, actor?, refId?, skip? }
 *   refId (the transaction id) gives the dedupe key, so the same transaction can never produce two events.
 * @returns {Promise<{recorded: boolean, id?: string, reason?: string}>}
 */
async function recordMemberEvent(db, ev) {
  try {
    if (ev.skip) return { recorded: false, reason: 'skipped' };
    if (!KINDS[ev.kind]) return { recorded: false, reason: 'unknown_kind' };
    if (!ev.coopId || !ev.memberId) return { recorded: false, reason: 'missing_ids' };

    const [{ data: society }, { data: member }] = await Promise.all([
      db.from('coop_societies').select('name').eq('coop_id', ev.coopId).maybeSingle(),
      db.from('coop_members').select('name, phone_normalized').eq('id', ev.memberId).maybeSingle(),
    ]);
    if (!member) return { recorded: false, reason: 'member_not_found' };

    const message = buildMessage(ev.kind, { ...ev, societyName: society && society.name, memberName: member.name });
    const title = KINDS[ev.kind].title;
    const actor = ev.actor || 'system';
    const dedupeKey = ev.refId ? `${ev.kind}:${ev.refId}` : null;

    const { data: row, error } = await db.from('coop_member_events').insert({
      coop_id: ev.coopId, member_id: ev.memberId, kind: ev.kind, title, message,
      amount_kobo: ev.amountKobo != null ? ev.amountKobo : null, reference: ev.reference || null,
      actor, dedupe_key: dedupeKey, member_phone: member.phone_normalized || null,
    }).select('id').single();
    if (error) return { recorded: false, reason: error.code === '23505' ? 'duplicate' : error.message };

    // The member's own in-app feed. A failure here leaves the event in the outbox, so it is not fatal.
    const { data: note } = await db.from('coop_notifications').insert({
      coop_id: ev.coopId, target_type: 'individual', target_member_id: ev.memberId, title, body: message, sent_by: actor,
    }).select('id').single();
    if (note && note.id) await db.from('coop_member_events').update({ notification_id: note.id }).eq('id', row.id);

    return { recorded: true, id: row.id };
  } catch (e) {
    console.error('[coopMemberEvents] could not record event:', e.message);
    return { recorded: false, reason: e.message };
  }
}

module.exports = { KINDS, buildMessage, naira, waPhone, whatsappUrl, recordMemberEvent };
