/**
 * zillion/mint/keygen.js
 *
 * One-time key generation for the Zillion Mint.
 * Run ONCE before launch: npm run mint:keygen
 *
 * OUTPUT: Prints the key pair to console.
 * NEVER save to files. Copy directly into Netlify environment variables.
 *
 * In production: Replace with AWS KMS key generation.
 */

'use strict';

const { generateMintKeyPair } = require('../backend/lib/crypto');

console.log('\n╔══════════════════════════════════════════════════════════╗');
console.log('║         ZILLION MINT — KEY GENERATION                   ║');
console.log('║         Run once. Store in Netlify env vars only.       ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');

const keys = generateMintKeyPair();

console.log('Ed25519 Key Pair Generated:\n');
console.log('MINT_PRIVATE_KEY_HEX=' + keys.privateKeyHex);
console.log('\nMINT_PUBLIC_KEY_HEX=' + keys.publicKeyHex);

console.log('\n⚠️  SECURITY INSTRUCTIONS:');
console.log('  1. Copy both values above into Netlify Environment Variables');
console.log('  2. NEVER commit these to GitHub');
console.log('  3. NEVER save to any file in this project');
console.log('  4. Store a secure backup in a password manager or vault');
console.log('  5. The public key can be shared — embed in the mobile app');
console.log('  6. The private key MUST remain secret — compromise = forged coins\n');

// Also output a test: sign and verify something
const { sign, verify } = require('../backend/lib/crypto');
const testData   = 'ZILLION_MINT_TEST_' + Date.now();
const signature  = sign(testData, keys.privateKeyHex);
const isValid    = verify(testData, signature, keys.publicKeyHex);

console.log('Self-test: sign → verify =', isValid ? '✅ PASSED' : '❌ FAILED');
console.log('');
