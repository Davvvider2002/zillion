/**
 * zillion/backend/lib/ajoNotifications.js
 *
 * In-app notifications for Ajo — parallel to coop_notifications, not a reuse of it: an Ajo scheme has no
 * coop_id (most never become a formal coop), so members are addressed by zillion_id directly.
 *
 * Every reminder created by the nightly passes (ajoNightlyPasses.js) carries a dedupe_key with a UNIQUE
 * constraint, so re-running the same night's pass twice — or a slow function retrying — can never send the
 * same reminder twice; the second insert simply hits the constraint and is silently skipped.
 */
'use strict';

const { fetchAllRows, chunk } = require('./coopPaginate');

async function notify(db, { schemeId = null, targetType, targetZillionId = null, type, title, message, dedupeKey = null, metadata = null }) {
  const { error } = await db.from('ajo_notifications').insert({
    scheme_id: schemeId, target_type: targetType, target_zillion_id: targetZillionId,
    type, title, message, dedupe_key: dedupeKey, metadata,
  });
  if (error && error.code !== '23505') throw new Error(error.message); // 23505 = this exact reminder already exists — not an error
  return { sent: !error };
}

/**
 * For the nightly passes: every reminder for the whole run in ONE request, not one insert per member.
 * ignoreDuplicates on the dedupe_key conflict means a reminder already sent for that exact due-period is
 * silently skipped rather than failing the whole batch.
 * @param {Array<object>} rows  same shape as notify()'s options, camelCase keys converted to columns here
 */
async function notifyBulk(db, rows) {
  if (!rows.length) return { inserted: 0 };
  const payload = rows.map(r => ({
    scheme_id: r.schemeId ?? null, target_type: r.targetType, target_zillion_id: r.targetZillionId ?? null,
    type: r.type, title: r.title, message: r.message, dedupe_key: r.dedupeKey ?? null, metadata: r.metadata ?? null,
  }));
  const { error } = await db.from('ajo_notifications').upsert(payload, { onConflict: 'dedupe_key', ignoreDuplicates: true });
  if (error) throw new Error(error.message);
  return { inserted: payload.length };
}

/** A member's own feed: individual notifications addressed to them, plus broadcasts for schemes they belong to. */
async function listForMember(db, zillionId, schemeIds) {
  const individual = await fetchAllRows(() => db.from('ajo_notifications')
    .select('*').eq('target_type', 'individual').eq('target_zillion_id', zillionId).order('created_at', { ascending: false }).order('id'));

  let broadcasts = [];
  const uniqueSchemeIds = [...new Set(schemeIds)].filter(Boolean);
  for (const part of chunk(uniqueSchemeIds)) {
    broadcasts.push(...await fetchAllRows(() => db.from('ajo_notifications')
      .select('*').eq('target_type', 'scheme_broadcast').in('scheme_id', part).order('created_at', { ascending: false }).order('id')));
  }

  const all = [...individual, ...broadcasts].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const reads = await fetchAllRows(() => db.from('ajo_notification_reads').select('notification_id').eq('zillion_id', zillionId).order('notification_id'));
  const readIds = new Set(reads.map(r => r.notification_id));

  return all.map(n => ({ ...n, read: readIds.has(n.id) }));
}

async function markRead(db, notificationId, zillionId) {
  const { error } = await db.from('ajo_notification_reads').upsert(
    { notification_id: notificationId, zillion_id: zillionId },
    { onConflict: 'notification_id,zillion_id' },
  );
  if (error) throw new Error(error.message);
}

module.exports = { notify, notifyBulk, listForMember, markRead };
