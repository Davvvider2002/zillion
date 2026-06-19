/**const { KMSClient, SignCommand, GetPublicKeyCommand } = require("@aws-sdk/client-kms");

 * zillion/backend/lib/mint.js
 *
 * The Zillion Mint — creates and signs .zil coin files.
 * This is the root of trust for the entire system.
 *
 * In production: MINT_PRIVATE_KEY_HEX comes from AWS KMS / HSM.
 * In POC/dev:    loaded from environment variable.
 *
 * The Mint never stores private keys in code. Ever.
 */

'use strict';

const {
  sign,
  computePayloadHash,
  computeOwnerHash,
  generateCoinId,
  sha256,
} = require('./crypto');

const COIN_VERSION  = '1.0';
const CURRENCY      = 'NGN';

/**
 * Issue a batch of .zil coins.
 *
 * @param {object} params
 * @param {number}   params.totalAmountKobo  — total value to issue in kobo (100 kobo = ₦1)
 * @param {number}   params.coinValueKobo    — denomination per coin (e.g. 100000 = ₦1,000)
 * @param {string}   params.recipientPhone   — recipient phone number (E.164)
 * @param {string}   params.recipientDevice  — recipient device ID
 * @param {string}   params.agentId          — issuing agent ID
 * @param {string}   params.mintPrivateKey   — hex-encoded Ed25519 private key
 * @param {string}   params.mintId           — mint identifier string
 * @param {string}   params.ownerSalt        — secret salt for owner hash (from env)
 * @param {number}   params.sequenceStart    — coin sequence start number
 * @param {number}   params.expiryDays       — days until coin expires
 *
 * @returns {object[]} array of signed .zil coin objects
 */
function issueCoinBatch({
  totalAmountKobo,
  coinValueKobo,
  recipientPhone,
  recipientDevice,
  agentId,
  mintPrivateKey,
  mintId,
  ownerSalt,
  sequenceStart = 1,
  expiryDays    = 90,
}) {
  if (totalAmountKobo % coinValueKobo !== 0) {
    throw new Error(
      `Total amount ${totalAmountKobo} kobo is not evenly divisible ` +
      `by coin value ${coinValueKobo} kobo`
    );
  }

  const coinCount  = totalAmountKobo / coinValueKobo;
  const ownerHash  = computeOwnerHash(recipientPhone, recipientDevice, ownerSalt);
  const issuedAt   = new Date().toISOString();
  const expiresAt  = new Date(Date.now() + expiryDays * 86400 * 1000).toISOString();
  const dateStr    = issuedAt.slice(0, 10);

  let previousCoinId = 'GENESIS'; // chain anchor for first coin in batch
  const coins = [];

  for (let i = 0; i < coinCount; i++) {
    const coin_id    = generateCoinId(dateStr, sequenceStart + i);
    const chain_hash = sha256(previousCoinId);

    const coreFields = {
      version:    COIN_VERSION,
      coin_id,
      amount:     coinValueKobo,
      currency:   CURRENCY,
      issued_at:  issuedAt,
      expires_at: expiresAt,
      issuer:     mintId,
      owner_hash: ownerHash,
      chain_hash,
    };

    const payload_hash = computePayloadHash(coreFields);
    const signature    = sign(async function kmsSign(payloadHash) {
  const client  = new KMSClient({ region: process.env.AWS_REGION });
  const command = new SignCommand({
    KeyId:            process.env.KMS_KEY_ARN,
    Message:          Buffer.from(payloadHash, "hex"),
    MessageType:      "DIGEST",
    SigningAlgorithm: "ECDSA_SHA_256",   // matches ECC_NIST_P256 key
  });
  const response = await client.send(command);
  return Buffer.from(response.Signature).toString("hex");
}
);

    const coin = {
      ...coreFields,
      payload_hash,
      signature,
      tx_history: [
        {
          from:   'MINT',
          to:     agentId,
          ts:     issuedAt,
          tx_sig: signature, // Mint's signature serves as the first history entry
        },
      ],
    };

    coins.push(coin);
    previousCoinId = coin_id;
  }

  return coins;
}

/**
 * Verify a coin's Mint signature.
 * Can be called fully offline — only needs the Mint public key.
 *
 * @param {object} coin          — the .zil coin object to verify
 * @param {string} mintPublicKey — hex-encoded Mint Ed25519 public key
 * @returns {{ valid: boolean, reason?: string }}
 */
function verifyCoinSignature(coin, mintPublicKey) {
  const { verify: cryptoVerify, computePayloadHash: computeHash } = require('./crypto');

  // 1. Recompute payload hash from coin fields
  const expectedHash = computeHash({
    version:    coin.version,
    coin_id:    coin.coin_id,
    amount:     coin.amount,
    currency:   coin.currency,
    issued_at:  coin.issued_at,
    expires_at: coin.expires_at,
    issuer:     coin.issuer,
    owner_hash: coin.owner_hash,
    chain_hash: coin.chain_hash,
  });

  // 2. Check hash integrity
  if (expectedHash !== coin.payload_hash) {
    return { valid: false, reason: 'PAYLOAD_HASH_MISMATCH — coin fields have been tampered' };
  }

  // 3. Verify Ed25519 signature
  const sigValid = cryptoVerify(coin.payload_hash, coin.signature, mintPublicKey);
  if (!sigValid) {
    return { valid: false, reason: 'INVALID_SIGNATURE — not signed by known Mint key' };
  }

  // 4. Check expiry
  if (new Date(coin.expires_at) < new Date()) {
    return { valid: false, reason: 'COIN_EXPIRED' };
  }

  return { valid: true };
}

/**
 * Append a transfer hop to a coin's tx_history.
 * Called when a coin changes hands.
 *
 * @param {object} coin           — the coin being transferred
 * @param {string} fromHash       — sender owner_hash
 * @param {string} toHash         — recipient owner_hash (new owner)
 * @param {string} senderPrivKey  — sender device private key
 * @param {string} ownerSalt      — salt for owner hash
 * @returns {object} updated coin with new owner_hash and tx_history entry
 */
function transferCoin(coin, fromHash, toHash, senderPrivKey) {
  const { sign: cryptoSign, sha256: cryptoHash } = require('./crypto');

  const ts       = new Date().toISOString();
  const hopData  = `${coin.coin_id}|${fromHash}|${toHash}|${ts}`;
  const tx_sig   = cryptoSign(cryptoHash(hopData), senderPrivKey);

  return {
    ...coin,
    owner_hash: toHash,
    tx_history: [
      ...coin.tx_history,
      { from: fromHash, to: toHash, ts, tx_sig },
    ],
  };
}

module.exports = { issueCoinBatch, verifyCoinSignature, transferCoin };
