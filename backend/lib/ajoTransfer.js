/**
 * zillion/backend/lib/ajoTransfer.js
 *
 * Real outbound money movement for Ajo payouts and withdrawals - the
 * piece that was missing from the entire platform, not just Ajo:
 * Coop's own loan disbursement is explicitly database-only ("this
 * only RECORDS that disbursement happened — it does not move any
 * money itself"), confirmed by reading that code directly rather
 * than assumed. There was no existing transfer implementation
 * anywhere in this codebase to mirror, unlike the virtual-account
 * provisioning work, which had Coop's proven pattern to copy.
 *
 * Uses the same v4 OAuth credentials already used for virtual account
 * provisioning (getFlutterwaveAccessToken/flutterwaveApiBase) rather
 * than the older v3 secret-key transfers endpoint, for consistency -
 * Flutterwave's own "Loan disbursements" documentation recommends the
 * v4 direct-transfers endpoint as the current path for payouts.
 *
 * THE SINGLE MOST IMPORTANT FACT IN THIS FILE: Flutterwave's Transfer
 * API expects amounts in NAIRA (major units), not kobo - confirmed
 * independently across multiple sources during research, including an
 * integration guide that calls this out explicitly as "the single
 * most consequential fact to know" before touching their transfer
 * APIs. Every amount everywhere else in this entire Ajo build is
 * stored in kobo. The conversion happens in exactly one place
 * (koboToNaira below) precisely so it can never be silently skipped
 * or duplicated by a caller reimplementing it inline.
 *
 * Before sending money, the recipient's account is verified via
 * Flutterwave's own account-resolve endpoint - never trusting a
 * stored account number blindly, matching the same "never trust
 * without verifying" discipline applied to every other Flutterwave
 * integration in this build.
 */
'use strict';

const { getFlutterwaveAccessToken, flutterwaveApiBase } = require('./flutterwave');

function koboToNaira(amountKobo) {
  return amountKobo / 100;
}

/**
 * Finds a Nigerian bank's numeric code from its name, since Flutterwave's
 * virtual-account response only ever gave us account_bank_name (e.g.
 * "GUARANTY TRUST BANK PLC"), never a code - a transfer needs the code.
 * @returns {Promise<string|null>}
 */
async function resolveBankCode(bankName) {
  if (!bankName) return null;
  const accessToken = await getFlutterwaveAccessToken();
  const base = flutterwaveApiBase();
  const res = await fetch(`${base}/banks?country=NG`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  const banks = data.data || [];
  const normalisedTarget = bankName.trim().toUpperCase();
  const match = banks.find(b => (b.name || '').trim().toUpperCase() === normalisedTarget)
    || banks.find(b => normalisedTarget.includes((b.name || '').trim().toUpperCase()) || (b.name || '').trim().toUpperCase().includes(normalisedTarget));
  return match ? match.code : null;
}

/**
 * Confirms an account number under a given bank code actually
 * resolves to a real, named account before any money is sent.
 * @returns {Promise<{ok: true, accountName: string} | {ok: false, error: string}>}
 */
async function verifyRecipientAccount(accountNumber, bankCode) {
  try {
    const accessToken = await getFlutterwaveAccessToken();
    const base = flutterwaveApiBase();
    const res = await fetch(`${base}/banks/account-resolve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: { code: bankCode, number: accountNumber }, currency: 'NGN' }),
    });
    const data = await res.json();
    const accountName = data.data?.account_name;
    if (!res.ok || !accountName) return { ok: false, error: data.message || 'Could not verify this account with the bank' };
    return { ok: true, accountName };
  } catch (e) {
    return { ok: false, error: `Failed to reach Flutterwave for account verification: ${e.message}` };
  }
}

/**
 * Initiates the actual transfer. amountKobo is converted to naira
 * internally - callers always pass kobo, matching every other amount
 * in this codebase, and never need to remember the conversion
 * themselves.
 * @returns {Promise<{ok: true, reference: string, flwStatus: string} | {ok: false, error: string}>}
 */
async function initiateTransfer({ accountNumber, bankCode, amountKobo, narration, reference }) {
  try {
    const accessToken = await getFlutterwaveAccessToken();
    const base = flutterwaveApiBase();
    const res = await fetch(`${base}/direct-transfers`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json',
        'X-Trace-Id': reference, 'X-Idempotency-Key': reference,
      },
      body: JSON.stringify({
        action: 'instant',
        type: 'bank',
        narration,
        reference,
        payment_instruction: {
          source_currency: 'NGN',
          destination_currency: 'NGN',
          amount: { applies_to: 'destination_currency', value: koboToNaira(amountKobo) },
          recipient: { bank: { account_number: accountNumber, code: bankCode } },
        },
      }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.message || 'Flutterwave rejected the transfer request' };
    return { ok: true, reference, flwStatus: data.data?.status || data.status || 'QUEUED' };
  } catch (e) {
    return { ok: false, error: `Failed to reach Flutterwave for transfer: ${e.message}` };
  }
}

module.exports = { koboToNaira, resolveBankCode, verifyRecipientAccount, initiateTransfer };
