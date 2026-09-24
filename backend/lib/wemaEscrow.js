/**
 * zillion/backend/lib/wemaEscrow.js
 *
 * Integration boundary for Wema Bank's Wallet Services (ALAT
 * Playground: Wallet Creation, Debit Wallet, Credit Wallet, Account
 * Management, Transaction Notification APIs).
 *
 * HONEST STATE OF THIS FILE: Zillion does not yet have a live partner
 * relationship or API credentials with Wema. Getting one requires a
 * real business-level integration request through Wema (the "Go
 * Live" step on their developer portal), not a self-service signup -
 * this is the same kind of gate Flutterwave v4 hit earlier in this
 * build. Rather than fabricate endpoint URLs or request/response
 * shapes I have not seen in real API reference docs (only a
 * marketing-level product description, not exact payloads), every
 * function here checks for WEMA_API_KEY / WEMA_PARTNER_ID and returns
 * a clear { ok: false, reason: 'not_configured' } when missing,
 * exactly like getFlutterwaveAccessToken()'s equivalent check. The
 * moment real credentials and Wema's actual API reference exist, only
 * the body of these three functions needs to change - every caller
 * elsewhere in the codebase already expects this exact return shape.
 *
 * What's confirmed, directly from Wema's own developer portal
 * (playground.alat.ng/product-wallet-services), not assumed:
 * - Wallet Creation API takes KYC info (NIN required) and returns a
 *   dedicated wallet.
 * - Debit Wallet API performs interbank/intrabank transfers FROM a
 *   wallet - this is what a real disbursement release would call.
 * - Notification API delivers real-time alerts on BOTH debit and
 *   credit transactions on a wallet - confirmed in their own wording
 *   ("notifications on all debit and credit transactions"), which is
 *   exactly the confirmation side of the disbursement reconciliation
 *   this system needs.
 */
'use strict';

function wemaConfigured() {
  return !!(process.env.WEMA_API_KEY && process.env.WEMA_PARTNER_ID);
}

/**
 * Creates a dedicated escrow wallet for a collector via Wema's Wallet
 * Creation API. kyc: { firstName, lastName, nin, phone, email }.
 *
 * Returns { ok: true, walletId, accountNumber, accountName } on
 * success, matching what ajo_collector_profiles.escrow_wallet_id /
 * escrow_account_number / escrow_account_name expect to store.
 */
async function createEscrowWallet(kyc) {
  if (!wemaConfigured()) {
    return { ok: false, reason: 'not_configured', message: 'WEMA_API_KEY / WEMA_PARTNER_ID are not set - Zillion does not yet have a live Wema partner integration. This requires a real onboarding relationship with Wema, not something that can be enabled from here.' };
  }
  // Real call goes here once credentials and Wema's actual API
  // reference (not just the marketing product page) are available.
  throw new Error('wemaEscrow.createEscrowWallet: WEMA_API_KEY is set but the real API call is not yet implemented - this stub was never wired to a live endpoint.');
}

/**
 * Initiates a debit (disbursement) from a collector's escrow wallet
 * via Wema's Debit Wallet API. This is the "intent" half of the
 * disbursement reconciliation - the caller records this as PENDING
 * in ajo_collector_escrow_disbursements, and Wema's own Notification
 * API confirms it independently (see confirmEscrowDisbursement below).
 */
async function debitEscrowWallet(walletId, amountKobo, reference) {
  if (!wemaConfigured()) {
    return { ok: false, reason: 'not_configured', message: 'WEMA_API_KEY / WEMA_PARTNER_ID are not set - cannot initiate a real disbursement without a live Wema integration.' };
  }
  throw new Error('wemaEscrow.debitEscrowWallet: WEMA_API_KEY is set but the real API call is not yet implemented - this stub was never wired to a live endpoint.');
}

/**
 * Called from the webhook handler that will eventually receive
 * Wema's Transaction Notification API callbacks. Not implemented yet
 * for the same reason as above - documented here so the shape of
 * what's needed is clear once real Wema webhook documentation is
 * available (their notification payload format is not published on
 * the marketing product page this research was based on).
 */
async function verifyEscrowNotificationSignature(headers, rawBody) {
  throw new Error('wemaEscrow.verifyEscrowNotificationSignature: not implemented - Wema webhook signature scheme is not yet known; do not trust an unverified notification as real confirmation.');
}

module.exports = { wemaConfigured, createEscrowWallet, debitEscrowWallet, verifyEscrowNotificationSignature };
