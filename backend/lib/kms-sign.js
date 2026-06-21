/**
 * zillion/backend/lib/kms-sign.js
 *
 * KMS-backed signing — replaces direct Ed25519 private key usage.
 * Called by mint.js instead of crypto.sign() when KMS env vars are set.
 *
 * Uses ZILLION_AWS_KEY_ID / ZILLION_AWS_SECRET / ZILLION_AWS_REGION
 * (not AWS_* prefix — those are reserved by Netlify)
 */
'use strict';

const { createHash } = require('crypto');

/**
 * Sign a payload hash using AWS KMS.
 * @param {string} payloadHash  — hex string (SHA-256 of coin fields)
 * @returns {Promise<string>}   — hex-encoded DER signature
 */
async function kmsSign(payloadHash) {
  const { KMSClient, SignCommand } = require('@aws-sdk/client-kms');

  const client = new KMSClient({
    region: process.env.ZILLION_AWS_REGION || process.env.AWS_REGION,
    credentials: {
      accessKeyId:     process.env.ZILLION_AWS_KEY_ID     || process.env.ZILLION_ACCESS_KEY_ID,
      secretAccessKey: process.env.ZILLION_AWS_SECRET      || process.env.ZILLION_SECRET_ACCESS_KEY,
    },
  });

  const command = new SignCommand({
    KeyId:            process.env.ZILLION_KMS_KEY_ARN,
    Message:          Buffer.from(payloadHash, 'hex'),
    MessageType:      'DIGEST',
    SigningAlgorithm: 'ECDSA_SHA_256',
  });

  const response = await client.send(command);
  return Buffer.from(response.Signature).toString('hex');
}

/**
 * Decide whether to use KMS or the local private key.
 * KMS is used when ZILLION_KMS_KEY_ARN is set.
 * Falls back to local key for dev/test.
 *
 * @param {string} payloadHash    — hex SHA-256 of coin fields
 * @param {string} mintPrivateKey — hex private key (used only if KMS not configured)
 * @returns {Promise<string>}     — hex signature
 */
async function signWithKMSOrKey(payloadHash, mintPrivateKey) {
  if (process.env.ZILLION_KMS_KEY_ARN) {
    return await kmsSign(payloadHash);
  }

  // Fallback: local Ed25519 key (dev/test only)
  if (!mintPrivateKey) {
    throw new Error(
      'No signing method available: ZILLION_KMS_KEY_ARN not set and ' +
      'MINT_PRIVATE_KEY_HEX not provided. Set one of these in Netlify env vars.'
    );
  }

  const { sign } = require('./crypto');
  return sign(payloadHash, mintPrivateKey);
}

module.exports = { kmsSign, signWithKMSOrKey };
