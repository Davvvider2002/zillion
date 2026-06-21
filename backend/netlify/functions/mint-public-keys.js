/**
 * GET /api/v1/mint-public-keys
 * Sprint 1: Returns the active KMS public key(s) for offline coin verification.
 * Wallets, agents and merchants fetch this on startup and cache in sessionStorage.
 * The public key is safe to expose — it can only verify, never sign.
 */
'use strict';

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=3600' }; // cache 1 hour

  if (event.httpMethod !== 'GET')
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  const publicKeyHex = process.env.MINT_PUBLIC_KEY_HEX;
  const mintId       = process.env.MINT_ID || 'ZILLION-MINT-01';
  const kmsArn       = process.env.ZILLION_KMS_KEY_ARN || null;

  if (!publicKeyHex) {
    return {
      statusCode: 503,
      headers: hdr,
      body: JSON.stringify({ error: 'MINT_PUBLIC_KEY_HEX not configured' }),
    };
  }

  // Return array format — supports multiple keys during key rotation
  const keys = [
    {
      kid:           mintId,
      public_key_hex: publicKeyHex,
      algorithm:     'ECDSA_SHA_256',   // ECC_NIST_P256 from AWS KMS
      curve:         'P-256',
      kms_arn:       kmsArn,
      active:        true,
      published_at:  '2026-06-01T00:00:00Z',
    },
  ];

  return {
    statusCode: 200,
    headers:    hdr,
    body:       JSON.stringify({ keys, count: keys.length }),
  };
};
