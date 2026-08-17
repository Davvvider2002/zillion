/**
 * zillion/backend/lib/zillionId.js
 *
 * Resolves or creates a person's unified Zillion ID from their phone
 * number. One identity per PERSON, not per role — a wallet user who
 * later registers as a merchant with the same phone number gets linked
 * to the SAME zillion_id, not a second, disconnected one.
 *
 * Every registration/activation touchpoint (verify-otp.js on every
 * wallet login, merchant-register.js, admin-create-agent.js,
 * bank-activate-customer.js) should call this and store the result on
 * its own record (devices.zillion_id / merchants.zillion_id /
 * agents.zillion_id).
 *
 * Deliberately simple select-then-insert-with-fallback rather than a
 * single upsert — predictable, easy to reason about, and identity
 * creation is inherently low-frequency (once per person, not once per
 * transaction), so the extra round-trip on first creation doesn't matter.
 */
'use strict';

/**
 * @param {object} db  Supabase client (service role)
 * @param {string} phoneNormalized  Already-normalised phone (+234...)
 * @param {string} [roleHint]  'wallet' | 'merchant' | 'agent' | 'bank_customer' — informational only
 * @returns {Promise<string>} the zillion_id (existing or newly created)
 */
async function resolveOrCreateZillionId(db, phoneNormalized, roleHint) {
  if (!phoneNormalized) throw new Error('resolveOrCreateZillionId: phoneNormalized is required');

  const { data: existing } = await db
    .from('zillion_identities')
    .select('zillion_id')
    .eq('phone_normalized', phoneNormalized)
    .maybeSingle();
  if (existing) return existing.zillion_id;

  const { data: created, error } = await db
    .from('zillion_identities')
    .insert({ phone_normalized: phoneNormalized, first_seen_as: roleHint || null })
    .select('zillion_id')
    .single();

  if (error) {
    // Race condition: another request created this identity between our
    // SELECT and INSERT (phone_normalized is UNIQUE, so this insert
    // failed) — re-query rather than treat it as a real failure.
    const { data: retry } = await db
      .from('zillion_identities')
      .select('zillion_id')
      .eq('phone_normalized', phoneNormalized)
      .maybeSingle();
    if (retry) return retry.zillion_id;
    throw error;
  }

  return created.zillion_id;
}

module.exports = { resolveOrCreateZillionId };
