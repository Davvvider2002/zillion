/**
 * zillion/backend/lib/crypto.js
 * Core cryptographic operations. Node.js 18+ native crypto only.
 */
'use strict';

const {
  generateKeyPairSync,
  sign:         nativeSign,
  verify:       nativeVerify,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  randomBytes,
} = require('crypto');

// ── Key Generation ────────────────────────────────────────────────────────────
function generateMintKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    publicKeyEncoding:  { type: 'spki',  format: 'der' },
  });
  return { privateKeyHex: privateKey.toString('hex'), publicKeyHex: publicKey.toString('hex') };
}

function generateDeviceKeyPair() { return generateMintKeyPair(); }

// ── Signing & Verification ────────────────────────────────────────────────────
function sign(data, privateKeyHex) {
  const keyObj     = createPrivateKey({ key: Buffer.from(privateKeyHex, 'hex'), format: 'der', type: 'pkcs8' });
  const dataBuffer = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
  return nativeSign(null, dataBuffer, keyObj).toString('hex');
}

function verify(data, signatureHex, publicKeyHex) {
  try {
    const keyObj     = createPublicKey({ key: Buffer.from(publicKeyHex, 'hex'), format: 'der', type: 'spki' });
    const dataBuffer = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
    return nativeVerify(null, dataBuffer, keyObj, Buffer.from(signatureHex, 'hex'));
  } catch { return false; }
}

// ── Hashing ───────────────────────────────────────────────────────────────────
function sha256(input) {
  return createHash('sha256')
    .update(typeof input === 'string' ? input : JSON.stringify(input))
    .digest('hex');
}

function computePayloadHash(coinFields) {
  const canonical = [
    coinFields.version, coinFields.coin_id, String(coinFields.amount),
    coinFields.currency, coinFields.issued_at, coinFields.expires_at,
    coinFields.issuer, coinFields.owner_hash, coinFields.chain_hash,
  ].join('|');
  return sha256(canonical);
}

// ── Owner Binding ─────────────────────────────────────────────────────────────
function computeOwnerHash(phoneNumber, deviceId, salt) {
  return createHmac('sha256', salt).update(`${phoneNumber}:${deviceId}`).digest('hex');
}

// ── Nonce & IDs ───────────────────────────────────────────────────────────────
function generateNonce() { return randomBytes(32).toString('hex'); }

function generateCoinId(dateStr, sequence) {
  const datePart   = dateStr.replace(/-/g, '');
  const randomPart = randomBytes(4).toString('hex').toUpperCase();
  const seqPart    = String(sequence).padStart(7, '0');
  return `ZIL-${datePart}-${randomPart}-${seqPart}`;
}

// ── Transfer Envelope ─────────────────────────────────────────────────────────
function buildTransferEnvelope(coins, fromHash, toHash, devicePrivateKey) {
  const nonce       = generateNonce();
  const timestamp   = new Date().toISOString();
  const coinIds     = coins.map(c => c.coin_id).sort();
  const totalAmount = coins.reduce((sum, c) => sum + c.amount, 0);
  const envelopeData = [coinIds.join(','), fromHash, toHash, timestamp, nonce, String(totalAmount)].join('|');
  const envelopeHash = sha256(envelopeData);
  const envSig       = sign(envelopeHash, devicePrivateKey);
  return { coins, from_hash: fromHash, to_hash: toHash, timestamp, nonce, total_amount: totalAmount, envelope_hash: envelopeHash, env_sig: envSig };
}

function verifyTransferEnvelope(envelope, devicePublicKey) {
  const coinIds = envelope.coins.map(c => c.coin_id).sort();
  const envelopeData = [coinIds.join(','), envelope.from_hash, envelope.to_hash, envelope.timestamp, envelope.nonce, String(envelope.total_amount)].join('|');
  const expectedHash = sha256(envelopeData);
  if (expectedHash !== envelope.envelope_hash) return false;
  return verify(envelope.envelope_hash, envelope.env_sig, devicePublicKey);
}

module.exports = {
  generateMintKeyPair, generateDeviceKeyPair, sign, verify,
  sha256, computePayloadHash, computeOwnerHash,
  generateNonce, generateCoinId, buildTransferEnvelope, verifyTransferEnvelope,
};
