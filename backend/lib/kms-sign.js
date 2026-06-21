/**
 * zillion/backend/lib/kms-sign.js
 *
 * KMS-backed signing — replaces direct Ed25519 private key usage.
 * Env vars (must match exactly what is set in Netlify):
 *   ZILLION_KMS_KEY_ARN        — full ARN e.g. arn:aws:kms:eu-north-1:873154291662:key/...
 *   ZILLION_ACCESS_KEY_ID      — IAM access key for zillion-mint-signer
 *   ZILLION_SECRET_ACCESS_KEY  — IAM secret key for zillion-mint-signer
 *   ZILLION_AWS_REGION         — e.g. eu-north-1 (also extracted from ARN as fallback)
 */
'use strict';

/**
 * Extract region from a KMS ARN.
 * arn:aws:kms:eu-north-1:873154291662:key/... → "eu-north-1"
 */
function regionFromArn(arn) {
  if (!arn || typeof arn !== 'string') return null;
  const parts = arn.split(':');
  return parts[3] || null;  // index 3 is always the region in an ARN
}

async function kmsSign(payloadHash) {
  const { KMSClient, SignCommand } = require('@aws-sdk/client-kms');

  const keyArn = process.env.ZILLION_KMS_KEY_ARN;

  // Region: explicit env var → extracted from ARN → hard fallback
  // Validate region looks like a real AWS region (e.g. eu-north-1, us-east-1)
  // Reject "Global", blank, or any other invalid value — extract from ARN instead
  const rawRegion  = (process.env.ZILLION_AWS_REGION || '').trim();
  const validRegex = /^[a-z]{2,}-[a-z]+-[0-9]+$/;
  const region =
    (validRegex.test(rawRegion) ? rawRegion : null) ||
    regionFromArn(keyArn) ||
    'eu-north-1';

  // Credentials: match EXACTLY the names set in Netlify
  const accessKeyId     = process.env.ZILLION_ACCESS_KEY_ID;
  const secretAccessKey = process.env.ZILLION_SECRET_ACCESS_KEY;

  // Validate before making the call — surface missing config clearly
  if (!region)         throw new Error('KMS config error: ZILLION_AWS_REGION not set and could not extract from ARN');
  if (!keyArn)         throw new Error('KMS config error: ZILLION_KMS_KEY_ARN not set');
  if (!accessKeyId)    throw new Error('KMS config error: ZILLION_ACCESS_KEY_ID not set');
  if (!secretAccessKey)throw new Error('KMS config error: ZILLION_SECRET_ACCESS_KEY not set');

  console.log('KMS sign: region=' + region + ' keyArn=' + keyArn.slice(0, 40) + '...');

  const client = new KMSClient({
    region,
    credentials: { accessKeyId, secretAccessKey },
  });

  const command = new SignCommand({
    KeyId:            keyArn,
    Message:          Buffer.from(payloadHash, 'hex'),
    MessageType:      'DIGEST',
    SigningAlgorithm: 'ECDSA_SHA_256',
  });

  const response = await client.send(command);
  return Buffer.from(response.Signature).toString('hex');
}

async function signWithKMSOrKey(payloadHash, mintPrivateKey) {
  if (process.env.ZILLION_KMS_KEY_ARN) {
    return await kmsSign(payloadHash);
  }

  // Fallback: local Ed25519 key (dev / test only)
  if (!mintPrivateKey) {
    throw new Error(
      'No signing method: set ZILLION_KMS_KEY_ARN (production) ' +
      'or MINT_PRIVATE_KEY_HEX (dev) in Netlify environment variables.'
    );
  }

  const { sign } = require('./crypto');
  return sign(payloadHash, mintPrivateKey);
}

module.exports = { kmsSign, signWithKMSOrKey };
