/**
 * zillion/backend/lib/merchantLookup.js
 *
 * Finds the merchant (society admin) that a phone number belongs to.
 *
 * A merchant_id such as MERCH-12345678 was originally derived from the last 8 digits of the registration phone. When Zillion staff
 * change a society admin's mobile number the merchant_id is NOT changed (many records point at it), so the phone can no longer be
 * assumed to match the id. Rules:
 *   1. A merchant whose stored phone is this number wins.
 *   2. Otherwise the id derived from the number is used, but only if that merchant's stored phone is empty or is the same number.
 *      That is what stops a number that was REPLACED from still opening the account through its old derived id.
 */
'use strict';

const digits = p => String(p == null ? '' : p).replace(/\D/g, '');
const last10 = p => digits(p).slice(-10);
const derivedMerchantId = phone => 'MERCH-' + digits(phone).slice(-8);

async function findMerchantByPhone(db, phone, columns) {
  const cols = columns || 'merchant_id, phone';
  const { data: byPhone } = await db.from('merchants').select(cols).eq('phone', phone).limit(1);
  if (byPhone && byPhone[0]) return byPhone[0];
  const { data: byId } = await db.from('merchants').select(cols).eq('merchant_id', derivedMerchantId(phone)).maybeSingle();
  if (!byId) return null;
  if (byId.phone && last10(byId.phone) !== last10(phone)) return null;   // the number on this account has been changed
  return byId;
}

module.exports = { findMerchantByPhone, derivedMerchantId, last10 };
