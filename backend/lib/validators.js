/**
 * zillion/backend/lib/validators.js
 *
 * Input validation and coin validation helpers.
 * Used across all Netlify functions.
 */

'use strict';

const { verifyCoinSignature } = require('./mint');

const MINT_PUBLIC_KEY = process.env.MINT_PUBLIC_KEY_HEX;

/**
 * Validate a .zil coin object structure and signature.
 * Can run fully offline — only needs Mint public key.
 *
 * @param {object} coin
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateCoin(coin) {
  const errors = [];

  // Required fields
  const required = ['version','coin_id','amount','currency','issued_at',
                    'expires_at','issuer','owner_hash','chain_hash',
                    'payload_hash','signature','tx_history'];
  for (const field of required) {
    if (coin[field] === undefined || coin[field] === null) {
      errors.push(`MISSING_FIELD: ${field}`);
    }
  }
  if (errors.length > 0) return { valid: false, errors };

  // Amount must be positive integer
  if (!Number.isInteger(coin.amount) || coin.amount <= 0) {
    errors.push('INVALID_AMOUNT: must be positive integer (kobo)');
  }

  // Currency must be NGN for pilot
  if (coin.currency !== 'NGN') {
    errors.push(`UNSUPPORTED_CURRENCY: ${coin.currency}`);
  }

  // Coin ID format: ZIL-YYYYMMDD-XXXXXXXX-NNNNNNN
  if (!/^ZIL-\d{8}-[A-F0-9]{8}-\d{7}$/.test(coin.coin_id)) {
    errors.push('INVALID_COIN_ID_FORMAT');
  }

  // tx_history must be array with at least one entry (Mint issuance)
  if (!Array.isArray(coin.tx_history) || coin.tx_history.length === 0) {
    errors.push('INVALID_TX_HISTORY');
  }

  if (errors.length > 0) return { valid: false, errors };

  // Cryptographic verification
  const sigCheck = verifyCoinSignature(coin, MINT_PUBLIC_KEY);
  if (!sigCheck.valid) {
    errors.push(sigCheck.reason);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate a sync batch payload.
 *
 * Accepts two payload shapes:
 *   Shape A (transaction records): { coin_id, from_hash, to_hash, tx_ts, env_sig }
 *   Shape B (coin records):        { coin_id, status, owner_hash, value_kobo, tx_history }
 *
 * Shape B is what wallets/merchants send. We accept both and derive
 * transaction fields from tx_history when the full tx fields are absent.
 */
function validateSyncBatch(body) {
  const errors = [];
  if (!body.device_id)               errors.push('MISSING: device_id');
  if (!Array.isArray(body.tx_batch)) errors.push('MISSING: tx_batch array');
  // Empty tx_batch is valid for heartbeat syncs (device registration with no pending coins)
  if (body.tx_batch?.length > 100)   errors.push('TOO_LARGE: max 100 transactions per sync');

  for (const tx of (body.tx_batch || [])) {
    if (!tx.coin_id) errors.push('TX missing coin_id');
    // Shape A: full tx fields present — strict check
    // Shape B: coin record with tx_history — coin_id alone is enough
    // We do not reject Shape B — processSyncBatch normalises it
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate an issue request from an agent.
 */
function validateIssueRequest(body) {
  const errors = [];
  const MAX_COIN = parseInt(process.env.MAX_COIN_VALUE_KOBO || '100000');
  const MAX_BAL  = parseInt(process.env.MAX_WALLET_BALANCE_KOBO || '1000000');

  if (!body.amount || !Number.isInteger(body.amount) || body.amount <= 0)
    errors.push('INVALID_AMOUNT');
  if (body.amount > MAX_BAL)
    errors.push(`AMOUNT_EXCEEDS_LIMIT: max ${MAX_BAL} kobo per issuance`);
  if (!body.recipient_hash)
    errors.push('MISSING: recipient_hash');
  if (!body.agent_id)
    errors.push('MISSING: agent_id');
  if (body.coin_denomination && body.coin_denomination > MAX_COIN)
    errors.push(`DENOMINATION_TOO_HIGH: max ${MAX_COIN} kobo`);

  return { valid: errors.length === 0, errors };
}

/**
 * Simple JWT verification (for Netlify functions).
 * In production, use a proper JWT library.
 */
function verifyJWT(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { valid: false, reason: 'MISSING_TOKEN' };
  }
  const token = authHeader.slice(7);
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return { valid: false, reason: 'MALFORMED_TOKEN' };
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    if (payload.exp && payload.exp < Date.now() / 1000) {
      return { valid: false, reason: 'TOKEN_EXPIRED' };
    }
    return { valid: true, payload };
  } catch {
    return { valid: false, reason: 'INVALID_TOKEN' };
  }
}

module.exports = { validateCoin, validateSyncBatch, validateIssueRequest, verifyJWT };
