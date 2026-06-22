# Zillion Monitoring Setup — Sprint 4

## UptimeRobot Configuration

### 1. Create free account
Go to https://uptimerobot.com → Sign up (free tier = 50 monitors)

### 2. Add these monitors

| Monitor Name | Type | URL | Interval | Alert |
|---|---|---|---|---|
| Zillion Health | HTTPS | https://zillion-mvp.netlify.app/api/v1/health | 5 min | Email + SMS |
| Zillion Wallet | HTTPS | https://zillion-mvp.netlify.app/wallet/ | 5 min | Email |
| Zillion Admin | HTTPS | https://zillion-mvp.netlify.app/admin/ | 5 min | Email |
| Zillion Agent | HTTPS | https://zillion-mvp.netlify.app/agent/ | 5 min | Email |
| Zillion Merchant | HTTPS | https://zillion-mvp.netlify.app/merchant/ | 5 min | Email |

### 3. Health check alert settings
- Alert contacts: your email + phone
- Alert after: 2 failed checks (10 minutes down)
- Alert on recovery: Yes

### 4. Status page
Create a public status page at: https://stats.uptimerobot.com/YOUR_ID
Share this URL with bank partners as the SLA reference.

---

## Sentry Error Monitoring

### 1. Create account
Go to https://sentry.io → Sign up → Create project → Node.js

### 2. Get DSN
Copy your DSN: https://XXXX@XXXX.ingest.sentry.io/XXXX

### 3. Add to Netlify env vars
```
SENTRY_DSN = https://XXXX@XXXX.ingest.sentry.io/XXXX
```

### 4. Install Sentry SDK
```powershell
npm install @sentry/node
git add package.json package-lock.json
git commit -m "chore: add Sentry error monitoring"
git push origin main
```

### 5. Add to backend/lib/sentry.js (create this file)
```javascript
'use strict';
const Sentry = require('@sentry/node');

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: 0.1,
  });
  console.log('[sentry] Initialized');
}

function captureError(error, context = {}) {
  if (process.env.SENTRY_DSN) {
    Sentry.withScope(scope => {
      Object.entries(context).forEach(([k, v]) => scope.setExtra(k, v));
      Sentry.captureException(error);
    });
  }
  console.error('[error]', error.message, context);
}

module.exports = { captureError };
```

### 6. Use in functions
```javascript
const { captureError } = require('../../lib/sentry');
// In catch blocks:
catch (e) {
  captureError(e, { function: 'admin-float-topup', agent_id });
  return err(500, `Mint failed: ${e.message}`);
}
```

### Key alerts to configure in Sentry
- Any 5xx error in production → immediate email
- Error rate spike (> 5 errors/min) → PagerDuty / SMS
- New error types → weekly digest

---

## CloudTrail (Already configured)
- Bucket: zillion-audit-logs-873154291662-d059d9fb
- Trail: zillion-audit-trail
- Region: eu-north-1
- Every KMS signing call is logged automatically

---

## Monthly cost estimate
- UptimeRobot free tier: $0
- Sentry free tier (5,000 errors/month): $0
- CloudTrail management events: $0
- Total monitoring cost: $0/month until scale requires paid tiers
