/**
 * zillion/backend/lib/coopKycBilling.js
 *
 * What a society is charged for coop-level NIN verifications, separate from the actual cost Zillion pays
 * Dojah. Policy (agreed explicitly, real money involved):
 *   - billed on EVERY attempt sent to Dojah, matched or not — Dojah charges Zillion per call either way
 *   - usage accrues into one invoice per society per calendar month
 *   - the nightly job finalizes last month's invoice once the month has ended, with a payment due date
 *   - if a society has any unpaid ('pending_payment') invoice, NEW verifications are blocked until it's paid —
 *     nothing else on the platform is affected
 */
'use strict';

const { fetchAllRows } = require('./coopPaginate');

const GRACE_DAYS_TO_PAY = 7;

class KycBillingError extends Error { constructor(code, message) { super(message); this.code = code; } }

function monthBounds(d) {
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  const start = new Date(Date.UTC(y, m, 1));
  const end = new Date(Date.UTC(y, m + 1, 0));
  const iso = x => x.toISOString().slice(0, 10);
  return { periodStart: iso(start), periodEnd: iso(end) };
}

async function getKycPriceKobo(db) {
  const { data } = await db.from('coop_kyc_pricing').select('price_kobo').eq('id', 'default').maybeSingle();
  return data ? data.price_kobo : 0;
}

async function setKycPriceKobo(db, priceKobo, updatedBy) {
  const { error } = await db.from('coop_kyc_pricing').update({ price_kobo: priceKobo, updated_at: new Date().toISOString(), updated_by: updatedBy }).eq('id', 'default');
  if (error) throw new Error(error.message);
}

/** Refuses to proceed if this society has an unpaid invoice from a previous month. */
async function assertNotBlocked(db, coopId) {
  const { data } = await db.from('coop_kyc_invoices').select('id, period_start, total_kobo').eq('coop_id', coopId).eq('status', 'pending_payment').order('period_start').limit(1);
  if (data && data.length) {
    throw new KycBillingError('UNPAID_INVOICE', `New NIN verifications are on hold: the ${data[0].period_start.slice(0, 7)} invoice is unpaid. Pay it to resume.`);
  }
}

async function getOrCreateAccruingInvoice(db, coopId, now = new Date()) {
  const { periodStart, periodEnd } = monthBounds(now);
  const { data: existing } = await db.from('coop_kyc_invoices').select('*').eq('coop_id', coopId).eq('period_start', periodStart).maybeSingle();
  if (existing) return existing;
  const { data: created, error } = await db.from('coop_kyc_invoices')
    .insert({ coop_id: coopId, period_start: periodStart, period_end: periodEnd, status: 'accruing' })
    .select().single();
  if (error) {
    if (error.code === '23505') { // lost a race to create it — read what the winner made
      const { data: raced } = await db.from('coop_kyc_invoices').select('*').eq('coop_id', coopId).eq('period_start', periodStart).maybeSingle();
      if (raced) return raced;
    }
    throw new Error(error.message);
  }
  return created;
}

/**
 * Records one Dojah attempt and its charge, and rolls it into the current month's accruing invoice.
 * Billed regardless of match outcome, per policy.
 */
async function recordVerificationAttempt(db, { coopId, memberId, ninHash, matched, dojahReference, dojahCostKobo, createdBy, now = new Date() }) {
  const priceKobo = await getKycPriceKobo(db);
  const invoice = await getOrCreateAccruingInvoice(db, coopId, now);

  const { data: row, error } = await db.from('coop_kyc_verifications').insert({
    coop_id: coopId, member_id: memberId, nin_hash: ninHash, matched: !!matched,
    dojah_reference: dojahReference || null, dojah_cost_kobo: dojahCostKobo || 0, charged_kobo: priceKobo,
    invoice_id: invoice.id, created_by: createdBy || null, created_at: now.toISOString(),
  }).select().single();
  if (error) throw new Error(error.message);

  await db.from('coop_kyc_invoices').update({
    verification_count: (invoice.verification_count || 0) + 1,
    total_kobo: (invoice.total_kobo || 0) + priceKobo,
    updated_at: now.toISOString(),
  }).eq('id', invoice.id);

  return { verification: row, chargedKobo: priceKobo };
}

async function listInvoicesForSociety(db, coopId) {
  const data = await fetchAllRows(() => db.from('coop_kyc_invoices').select('*').eq('coop_id', coopId).order('period_start', { ascending: false }).order('id'));
  return data;
}

async function markInvoicePaid(db, invoiceId, { txRef, flwTransactionId, now = new Date() } = {}) {
  const { error } = await db.from('coop_kyc_invoices').update({
    status: 'paid', tx_ref: txRef || null, flw_transaction_id: flwTransactionId || null, paid_at: now.toISOString(), updated_at: now.toISOString(),
  }).eq('id', invoiceId);
  if (error) throw new Error(error.message);
}

/**
 * KYC/NIN verification is only ever a live, billable action for a society on an active, paying subscription.
 * A trial society, or one flagged never_expires (demo/NGO/internal accounts that never go through checkout),
 * gets a no-op "test mode" instead: nothing is checked with Dojah, nothing is charged, and no member's
 * kyc_status is ever changed. This must be checked BEFORE any Dojah call or billing — a society only earns
 * real verification once it's actually paying for the platform.
 */
function isKycActiveForSociety(society) {
  return !!society && society.subscription_status === 'active' && !society.never_expires;
}

/**
 * Nightly bulk pass: any 'accruing' invoice whose month has already ended becomes 'pending_payment', due in
 * GRACE_DAYS_TO_PAY days. Zero-usage months are never finalized in the first place — an invoice row is only
 * created lazily on the first verification of a month — so there is nothing to finalize for a quiet society.
 */
async function finalizeEndedMonths(db, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const due = await fetchAllRows(() => db.from('coop_kyc_invoices').select('id, coop_id, period_end, total_kobo').eq('status', 'accruing').lt('period_end', today).order('id'));
  const dueAt = new Date(now.getTime() + GRACE_DAYS_TO_PAY * 86400000).toISOString();
  const finalized = [];
  for (const inv of due) {
    await db.from('coop_kyc_invoices').update({ status: 'pending_payment', due_at: dueAt, updated_at: now.toISOString() }).eq('id', inv.id);
    finalized.push(inv);
  }
  return finalized;
}

module.exports = {
  KycBillingError, getKycPriceKobo, setKycPriceKobo, assertNotBlocked, getOrCreateAccruingInvoice,
  recordVerificationAttempt, listInvoicesForSociety, markInvoicePaid, finalizeEndedMonths, monthBounds, GRACE_DAYS_TO_PAY,
  isKycActiveForSociety,
};
