# Zillion MVP — Project README

## Stack Overview

| Layer | Technology | Status |
|---|---|---|
| Database | Supabase (PostgreSQL) | ✅ Fully supported |
| Backend API | Netlify Functions (Node.js) | ✅ Fully supported |
| Frontend | Static HTML/CSS/JS | ✅ Fully supported |
| Source Control | GitHub | ✅ Fully supported |
| Cryptography | Node.js native crypto (Ed25519, SHA-256) | ✅ Built |
| Mobile App | React Native — Android first | ⚠️ Phase 2 |
| Offline Transfer | Bluetooth / NFC / QR | ⚠️ Phase 2 (mobile) |

---

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/your-org/zillion-mvp
cd zillion-mvp
npm install

# 2. Generate Mint keys (run ONCE)
npm run mint:keygen
# Copy output into Netlify environment variables

# 3. Set up environment
cp .env.example .env
# Fill in SUPABASE_URL, SUPABASE_SERVICE_KEY, MINT keys, JWT_SECRET

# 4. Run database migration
# Open Supabase dashboard → SQL Editor → paste contents of backend/db/schema.sql → run

# 5. Run the full test suite
npm run test:all

# 6. Run the transaction simulator
npm run sim:transaction

# 7. Start local dev server
npm run dev:backend
# Agent portal at: http://localhost:8888/agent/
```

---

## Skills Required — Full Team

### Cryptography (Co-Founder Domain)
- Ed25519 signature scheme — key generation, signing, verification
- SHA-256 and HMAC-SHA256 for hashing and owner binding
- ECDH for Bluetooth session key derivation
- AES-256-GCM for local vault encryption
- PBKDF2 for PIN-derived key generation
- Key management and rotation procedures
- HSM integration (production)

### Backend / API (Node.js)
- Netlify Functions (serverless Node.js)
- Supabase client and PostgreSQL query design
- JWT authentication and verification
- REST API design
- Rate limiting and basic DDoS protection
- Fraud detection logic

### Mobile Development (Phase 2)
- React Native (Android priority)
- Bluetooth Low Energy (BLE) — L2CAP channels
- NFC NDEF tag reading/writing
- QR code generation and scanning
- Local encrypted storage (SQLite + AES)
- Background sync service
- Offline-first state management

### Frontend (Web — Agent Portal + Admin)
- HTML / CSS / JavaScript (vanilla — no framework needed for MVP)
- Web Crypto API (browser-side HMAC for owner hash)
- QR code library (qrcode.js)
- Responsive mobile-first design (agents use phones)

### DevOps / Infrastructure
- GitHub Actions for CI/CD to Netlify
- Supabase database management and backups
- Environment variable management
- Netlify deploy previews for testing

### Product / Operations (Nigeria)
- Agent onboarding and training
- Market trader UX testing
- KYC process design
- CBN regulatory engagement

---

## APIs Required

### Already Available (No Additional Cost)

| API | Purpose | Notes |
|---|---|---|
| Supabase REST API | All database operations | Included in Supabase free/pro tier |
| Supabase Auth | Device and agent authentication | Built into Supabase |
| Netlify Functions | All backend serverless logic | Included in Netlify free tier for POC |
| Node.js crypto | Ed25519, SHA-256, HMAC, AES | Built into Node.js 18+ — zero cost |

### Required for Production (Not Yet Integrated)

| API / Service | Purpose | Estimated Cost |
|---|---|---|
| Twilio Verify or Africa's Talking | Phone number OTP verification for user registration | ~$0.05/verification |
| Africa's Talking SMS | Agent notifications, balance alerts | ~$0.004/SMS Nigeria |
| QR Code library (qrcode npm) | Coin bundle QR generation | Free (open source) |
| AWS KMS (production) | Mint private key management in HSM | ~$1/key/month + $0.03/10k calls |
| Paystack or Flutterwave | Agent float top-up via bank transfer | 1.5% + ₦100 per transaction |

### Phase 2 — Mobile (React Native)

| Library / API | Purpose |
|---|---|
| react-native-ble-plx | Bluetooth Low Energy transfer |
| react-native-nfc-manager | NFC tap transfer |
| react-native-camera or expo-barcode-scanner | QR scanning |
| react-native-encrypted-storage | Encrypted local vault |
| react-native-background-fetch | Background sync on connectivity |
| tweetnacl (React Native) | Ed25519 on mobile (native crypto may not expose Ed25519 on all Android versions) |

---

## What the Current Stack Handles Well

✅ Full cryptographic pipeline — mint, sign, verify, transfer envelopes
✅ Registry (Supabase) — coin state machine, transaction log, fraud events
✅ API layer (Netlify Functions) — issue, sync, redeem, validate endpoints
✅ Agent Portal (static HTML) — cash-in, cash-out, verify, history
✅ All server-side logic runs within free tiers for the 90-day pilot
✅ GitHub Actions can auto-deploy to Netlify on every push
✅ Supabase Row Level Security blocks all direct client DB access

---

## Known Gaps — Netlify/Supabase Stack

| Gap | Impact | Solution |
|---|---|---|
| No persistent background jobs | Can't auto-expire coins on schedule | Supabase pg_cron extension OR Netlify scheduled functions |
| No Redis cache | Double-spend check hits DB on every sync | Acceptable for POC (<50 users). Supabase connection pooling helps. |
| No WebSocket | Agent portal needs page refresh for updates | Use Supabase Realtime subscriptions |
| Netlify function cold starts | First call may be slow (~500ms) | Acceptable for POC. Netlify Pro reduces this. |
| No message queue | High-volume fraud processing may back up | Acceptable at pilot scale. Add Upstash or Supabase queue at scale. |
| Mobile app not a Netlify product | Bluetooth/NFC require native app | React Native built separately, calls Netlify Functions as API |
| USSD fallback | Feature phone users excluded | Out of scope for MVP. Phase 3. |
| File-based .zil distribution | Netlify Functions return JSON not file downloads | Return coin data as JSON array — client saves as .zil files |

---

## Folder Structure

```
zillion/
├── package.json                    # Root dependencies
├── netlify.toml                    # Netlify config + redirects
├── .env.example                    # Environment variable template
├── .gitignore
│
├── backend/
│   ├── lib/
│   │   ├── crypto.js               # Ed25519, SHA-256, HMAC, envelopes
│   │   ├── mint.js                 # Coin issuance and signature
│   │   ├── supabase.js             # All database operations
│   │   └── validators.js           # Input validation + JWT check
│   │
│   ├── netlify/
│   │   └── functions/
│   │       ├── issue.js            # POST /api/v1/issue
│   │       ├── sync.js             # POST /api/v1/sync
│   │       ├── redeem.js           # POST /api/v1/redeem
│   │       └── validate.js         # GET  /api/v1/validate
│   │
│   ├── db/
│   │   └── schema.sql              # Full Supabase schema + seed data
│   │
│   └── tests/
│       └── test-transaction.js     # End-to-end test suite (no network)
│
├── frontend/
│   ├── agent-portal/
│   │   └── index.html              # Agent cash-in/cash-out portal
│   ├── admin-dashboard/
│   │   └── index.html              # (Phase 2) Fraud monitoring, float mgmt
│   └── shared/
│       └── (shared CSS/JS assets)
│
├── mobile-sim/
│   └── simulate-transaction.js     # Full offline TX simulation (Node.js)
│
├── mint/
│   └── keygen.js                   # One-time Mint key generation
│
├── docs/
│   └── (architecture diagrams, API docs)
│
└── scripts/
    └── db-migrate.js               # Database migration helper
```

---

## Pilot Deployment Checklist

- [ ] Run `npm run mint:keygen` — copy keys to Netlify env vars
- [ ] Create Supabase project — run `backend/db/schema.sql`
- [ ] Set all env vars in Netlify (see `.env.example`)
- [ ] Push to GitHub — confirm Netlify auto-deploys
- [ ] Run `npm run sim:transaction` — confirm all steps pass
- [ ] Run `npm run test:all` — confirm all tests pass
- [ ] Open Agent Portal at `https://your-site.netlify.app/agent/`
- [ ] Test one complete cash-in flow with a test phone number
- [ ] Test one complete redeem flow
- [ ] Onboard 5 pilot agents — share Agent Portal URL
- [ ] Brief agents on cash-in/cash-out procedure
- [ ] Load ₦500,000 float across agents in Supabase
- [ ] Begin 90-day pilot

---

*Zillion MVP — Built on Supabase + Netlify + GitHub*
*Version 0.1 | June 2026 | Confidential*
