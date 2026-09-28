/**
 * zillion/backend/lib/coopAttribution.js
 *
 * Attributes the "unallocated" part of a control account to individual
 * members - who actually holds the opening balance the ledger already carries.
 *
 * The one rule that shapes everything: this NEVER posts to the ledger. The
 * ledger already holds this money (that is why it shows as unallocated);
 * attribution only creates the member-level records that say whose it is.
 * Posting again would double-count it.
 *
 * Supported today: share capital (recorded as opening_balance share
 * transactions) and member savings (the platform's own member-level opening
 * balance field, which the app already adds to a member's savings). Loans,
 * dues and investments need loan/plan/holding records rather than a balance
 * and are not attributable this way.
 *
 * Guard rails, enforced here and never trusted to the client:
 *  - the unallocated amount is recomputed at request time, and the total
 *    attributed can never exceed it;
 *  - every member must belong to this society and be activated;
 *  - shares are idempotent on a batch reference, so a retry can't double up;
 *  - savings updates are compare-and-set per member and rolled back together
 *    if any one fails.
 */
'use strict';

const { fetchAllRows } = require('./coopPaginate');
const subledgers = require('./coopSubledgers');

const ATTRIBUTABLE = {
  shares:  { label: 'Share capital',  controlKey: 'share_capital', mechanism: 'share_transactions' },
  savings: { label: 'Member savings', controlKey: 'balance',       mechanism: 'member_opening_balance' },
};

const naira = k => '₦' + (k / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fail = (status, error) => ({ ok: false, status, error });

async function unallocatedFor(db, coopId, type, deps) {
  const idx = subledgers.SUBLEDGERS[type].controls.findIndex(c => c.key === ATTRIBUTABLE[type].controlKey);
  const r = await subledgers.computeSubledger(db, coopId, type, null, deps);
  return { unallocated: r.reconciliation[idx].unallocated_kobo, report: r };
}

/** Opening balances belong at the opening date, so as-at reports before today still include them. */
async function defaultOpeningDate(db, coopId) {
  const first = async (extra) => {
    let q = db.from('coop_journal_entries').select('entry_date').eq('coop_id', coopId);
    if (extra) q = q.eq('entry_type', extra);
    const { data } = await q.order('entry_date', { ascending: true }).limit(1);
    return data && data[0] && data[0].entry_date;
  };
  return (await first('opening_balance')) || (await first(null)) || new Date().toISOString().slice(0, 10);
}

async function getAttributionContext(db, coopId, type, deps = {}) {
  const cfg = ATTRIBUTABLE[type];
  if (!cfg) return fail(400, `Attribution is only available for: ${Object.keys(ATTRIBUTABLE).join(', ')}`);
  const { unallocated, report } = await unallocatedFor(db, coopId, type, deps);
  const current = new Map(report.rows.map(r => [r.member_id, r.values[cfg.controlKey] || 0]));
  const members = await fetchAllRows(() => db.from('coop_members').select('id, name, phone_normalized, opening_balance_kobo').eq('coop_id', coopId).not('activated_at', 'is', null).order('id'));
  const noPlan = type === 'savings' ? await subledgers.membersWithoutSavingsPlan(db, coopId) : null;
  return {
    ok: true, type, label: cfg.label, mechanism: cfg.mechanism, unallocated_kobo: unallocated,
    default_date: await defaultOpeningDate(db, coopId),
    members: members.map(m => ({ id: m.id, name: m.name || m.phone_normalized || 'Unnamed member', phone_normalized: m.phone_normalized,
      current_kobo: current.get(m.id) || 0, opening_balance_kobo: m.opening_balance_kobo || 0, no_plan: noPlan ? noPlan(m.id) : false })),
  };
}

async function applyAttribution(db, coopId, type, attributions, { date, batchId, actor }, deps = {}) {
  const cfg = ATTRIBUTABLE[type];
  if (!cfg) return fail(400, `Attribution is only available for: ${Object.keys(ATTRIBUTABLE).join(', ')}`);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(batchId || '')) return fail(400, 'batch_id is required (8 to 64 letters, numbers, - or _)');
  if (!Array.isArray(attributions) || !attributions.length) return fail(400, 'Enter an amount for at least one member.');
  if (attributions.length > 1000) return fail(400, 'Too many members in one batch (limit 1,000).');

  const seen = new Set();
  for (const a of attributions) {
    if (!a || typeof a.member_id !== 'string' || !a.member_id) return fail(400, 'Every line needs a member_id.');
    if (!Number.isInteger(a.amount_kobo) || a.amount_kobo <= 0) return fail(400, 'Every amount must be a positive whole number of kobo.');
    if (seen.has(a.member_id)) return fail(400, 'Each member can appear only once in a batch.');
    seen.add(a.member_id);
  }

  const reference = `Opening balance attribution ${batchId}`;
  if (type === 'shares') {
    const { data: prior } = await db.from('coop_share_transactions').select('id').eq('coop_id', coopId).eq('reference', reference).limit(1);
    if (prior && prior.length) return fail(409, 'This attribution has already been applied.');
  }

  const ctx = await getAttributionContext(db, coopId, type, deps);
  if (!ctx.ok) return ctx;
  if (ctx.unallocated_kobo <= 0) return fail(409, ctx.unallocated_kobo === 0 ? 'Nothing is unallocated: this is already fully attributed to members.' : `Member records already exceed the ledger by ${naira(-ctx.unallocated_kobo)}, so there is nothing to attribute. Review the entries instead.`);

  const byId = new Map(ctx.members.map(m => [m.id, m]));
  for (const a of attributions) if (!byId.has(a.member_id)) return fail(400, 'One of the members does not belong to your society or is not activated.');

  const total = attributions.reduce((s, a) => s + a.amount_kobo, 0);
  if (total > ctx.unallocated_kobo) return fail(400, `That is ${naira(total)}, but only ${naira(ctx.unallocated_kobo)} is unallocated. Reduce the amounts by ${naira(total - ctx.unallocated_kobo)}.`);

  if (type === 'shares') {
    const day = date || ctx.default_date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day))) return fail(400, 'date must be YYYY-MM-DD');
    if (day > new Date().toISOString().slice(0, 10)) return fail(400, 'An opening balance cannot be dated in the future.');
    const { error } = await db.from('coop_share_transactions').insert(attributions.map(a => ({
      coop_id: coopId, member_id: a.member_id, amount_kobo: a.amount_kobo, source: 'opening_balance',
      reference, recorded_by: actor, recorded_at: `${day}T00:00:00Z` })));
    if (error) return fail(500, `Could not record the attribution: ${error.message}`);
  } else {
    const done = [];
    const rollback = async () => { for (const d of done) await db.from('coop_members').update({ opening_balance_kobo: d.before }).eq('id', d.id).eq('coop_id', coopId); };
    for (const a of attributions) {
      const before = byId.get(a.member_id).opening_balance_kobo;
      const { data, error } = await db.from('coop_members').update({ opening_balance_kobo: before + a.amount_kobo })
        .eq('id', a.member_id).eq('coop_id', coopId).eq('opening_balance_kobo', before).select('id');
      if (error || !data || !data.length) {
        await rollback();
        return fail(error ? 500 : 409, error ? `Could not record the attribution: ${error.message}. Nothing was changed.` : 'A member record changed while you were working. Nothing was changed; reload and try again.');
      }
      done.push({ id: a.member_id, before });
    }
  }

  const after = await unallocatedFor(db, coopId, type, deps);
  return { ok: true, applied: attributions.length, total_kobo: total, unallocated_before_kobo: ctx.unallocated_kobo, unallocated_after_kobo: after.unallocated };
}

module.exports = { getAttributionContext, applyAttribution, ATTRIBUTABLE };
