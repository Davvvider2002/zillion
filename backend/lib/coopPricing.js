/**
 * zillion/backend/lib/coopPricing.js
 *
 * Single source of truth for computing what a society actually owes —
 * base tier price plus any selected add-on modules, at whichever
 * billing cycle they chose. Used by both the self-service signup path
 * and the admin-created-society path, so the two can never compute a
 * different total for the same selection.
 *
 * Add-on prices are set by admin as a MONTHLY figure (matching how
 * they're entered in the admin panel). For yearly billing, the same
 * 15%-off convention already used for the base tiers is applied to
 * add-ons too, for one consistent, predictable pricing rule rather
 * than a different discount per component.
 */
'use strict';

const YEARLY_DISCOUNT = 0.85; // 15% off monthly × 12, same convention as the base tier catalog

function addonPriceForCycle(addonMonthlyKobo, cycle) {
  if (cycle === 'yearly') return Math.round(addonMonthlyKobo * 12 * YEARLY_DISCOUNT);
  return addonMonthlyKobo;
}

/**
 * @param {object} db
 * @param {{tier: string, cycle: string, addonKeys: string[]}} selection
 * @returns {Promise<{ok:true, totalKobo:number, tierKobo:number, addons:Array<{key,name,priceKobo}>} | {ok:false, error:string}>}
 */
async function computeSubscriptionTotal(db, { tier, cycle, addonKeys = [] }) {
  const { data: tierRow } = await db.from('coop_subscription_plan_catalog')
    .select('amount_kobo').eq('tier', tier).eq('cycle', cycle).maybeSingle();
  if (!tierRow) return { ok: false, error: `No catalog entry for ${tier}/${cycle}` };

  const uniqueKeys = [...new Set(addonKeys.filter(Boolean))];
  let addonModules = [];
  if (uniqueKeys.length) {
    const { data } = await db.from('coop_addon_modules').select('key, name, price_kobo, active').in('key', uniqueKeys);
    addonModules = data || [];
    const foundKeys = new Set(addonModules.map(a => a.key));
    const missing = uniqueKeys.filter(k => !foundKeys.has(k));
    if (missing.length) return { ok: false, error: `Unknown add-on(s): ${missing.join(', ')}` };
    const inactive = addonModules.filter(a => !a.active);
    if (inactive.length) return { ok: false, error: `Add-on(s) not currently available: ${inactive.map(a => a.name).join(', ')}` };
  }

  const addons = addonModules.map(a => ({ key: a.key, name: a.name, priceKobo: addonPriceForCycle(a.price_kobo, cycle) }));
  const addonsTotalKobo = addons.reduce((s, a) => s + a.priceKobo, 0);

  return { ok: true, totalKobo: tierRow.amount_kobo + addonsTotalKobo, tierKobo: tierRow.amount_kobo, addons };
}

/**
 * Called whenever a society's billable total changes after signup —
 * an admin changing their plan, or a society adding an add-on later.
 * The existing Flutterwave payment plan (sized for the OLD total) is
 * no longer correct, so it's cleared here; checkout-init.js creates a
 * fresh one, sized to the new total, the next time this society pays.
 * Flutterwave has no proration mechanism, so this deliberately doesn't
 * try to prorate a mid-cycle change — it requires a fresh payment for
 * the new total, same as a trial converting to paid. An already-active
 * society is moved back to pending_verification so payment on the new
 * total still goes through the same admin-activation gate everything
 * else does; a trial/pending society's status is left alone since
 * they're already headed toward a first payment regardless.
 *
 * repricing_pending_since starts the 7-day grace-period clock
 * (scheduled-reconcile.js) and is the real signal — not
 * subscription_paid_until — that a fresh payment is genuinely owed.
 * subscription_paid_until is cleared too: if this society was
 * previously paying, its old paid_until date is now stale and could
 * otherwise be misread elsewhere as evidence a new payment happened.
 */
async function invalidateSubscriptionForRepricing(db, coopId, currentStatus) {
  const update = { flutterwave_payment_plan_id: null, subscription_paid_until: null, repricing_pending_since: new Date().toISOString() };
  if (currentStatus === 'active') update.subscription_status = 'pending_verification';
  await db.from('coop_societies').update(update).eq('coop_id', coopId);
}

module.exports = { computeSubscriptionTotal, addonPriceForCycle, invalidateSubscriptionForRepricing, YEARLY_DISCOUNT };
