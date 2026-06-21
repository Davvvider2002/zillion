/**
 * GET /api/v1/health
 * Sprint 1: Startup gate — returns 200 if all required env vars are set and
 * Supabase is reachable. Returns 503 if anything is missing or broken.
 * Used by UptimeRobot for monitoring and as a deploy verification step.
 */
'use strict';

const { createClient } = require('@supabase/supabase-js');

const REQUIRED_VARS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'JWT_SECRET',
  'ADMIN_SECRET',
  'OTP_SECRET',
  'ADMIN_TOTP_SECRET',
  'SMS_PROVIDER',
  'ZILLION_KMS_KEY_ARN',
  'ZILLION_ACCESS_KEY_ID',
  'ZILLION_SECRET_ACCESS_KEY',
  'MINT_ID',
];

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };

  // Check all required env vars
  const missing = REQUIRED_VARS.filter(k => !process.env[k]);

  // Check Supabase connectivity
  let db_ok = false;
  let db_error = null;
  try {
    const db = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
      { auth: { persistSession: false } }
    );
    const { error } = await db.from('agents').select('agent_id').limit(1);
    db_ok    = !error;
    db_error = error?.message || null;
  } catch (e) {
    db_error = e.message;
  }

  const kms_configured = !!(
    process.env.ZILLION_KMS_KEY_ARN &&
    process.env.ZILLION_ACCESS_KEY_ID &&
    process.env.ZILLION_SECRET_ACCESS_KEY
  );

  const healthy = missing.length === 0 && db_ok;

  const payload = {
    status:          healthy ? 'ok' : 'degraded',
    version:         'v0.1',
    timestamp:       new Date().toISOString(),
    env_vars_ok:     missing.length === 0,
    missing_vars:    missing,
    db_ok,
    db_error,
    kms_configured,
    sms_provider:    process.env.SMS_PROVIDER || 'NOT SET',
  };

  return {
    statusCode: healthy ? 200 : 503,
    headers:    hdr,
    body:       JSON.stringify(payload, null, 2),
  };
};
