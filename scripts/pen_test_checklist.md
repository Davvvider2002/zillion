# Zillion Penetration Test Checklist — Sprint 4

## What to test before engaging external pen tester

### Self-assessment (run before external test)

#### Authentication
- [ ] Admin login with wrong secret → 401
- [ ] Admin login with correct secret but wrong TOTP → 401
- [ ] Replay old admin JWT after 8 hours → 401
- [ ] Bank API with wrong key → 401
- [ ] Bank API key in URL leaks into logs? → must NOT appear in Netlify logs

#### Injection
- [ ] SQL injection in phone field: `+234'; DROP TABLE devices;--` → must sanitise
- [ ] coin_id with path traversal: `ZIL-../../etc/passwd` → 400
- [ ] Oversized payload (>1MB body) → must reject

#### Rate limiting
- [ ] 11 consecutive /api/v1/issue calls → 11th must return 429
- [ ] 100 /api/v1/send-otp calls in 1 minute → must throttle
- [ ] /api/v1/validate flood → must throttle

#### Coin security
- [ ] Present a forged .zil file with fake coin_id → 404 or invalid
- [ ] Present expired coin → rejected
- [ ] Double-spend: sync same coin from two devices → second gets CONFLICT
- [ ] Grace period coin after grace expires → rejected

#### Admin security
- [ ] Admin endpoints without JWT → 403
- [ ] Customer JWT on admin endpoint → 403
- [ ] Agent JWT on admin endpoint → 403

#### Bank API security
- [ ] Bank endpoints without key → 401
- [ ] Bank activate-customer with duplicate bank_ref → idempotent 200
- [ ] Bank fund-float with negative amount → 400
- [ ] Bank fund-float amount not divisible by denomination → 400

## External pen test scope
Engage a Nigerian firm familiar with CBN systems.
Recommended: Cyber Shujaa, Sievert Larsen, or Control Risks (Lagos office)

### In-scope
- All /api/v1/* endpoints
- Admin portal authentication flow
- Coin cryptographic integrity
- Database access via API

### Out-of-scope
- Netlify infrastructure (not owned by Zillion)
- Supabase infrastructure (not owned by Zillion)
- AWS KMS infrastructure (not owned by Zillion)
- Physical security

### Deliverables required from pen tester
1. Executive summary (1 page)
2. Technical findings with CVSS scores
3. Proof-of-concept for each critical/high finding
4. Remediation recommendations
5. Re-test confirmation after fixes

### Acceptance criteria
- Zero critical findings
- Zero high findings
- Medium findings documented with remediation plan
