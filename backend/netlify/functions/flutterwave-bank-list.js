/**
 * zillion/backend/netlify/functions/flutterwave-bank-list.js
 *
 * GET /api/v1/flutterwave-bank-list
 *
 * Returns Flutterwave's real list of Nigerian banks (name + code) via
 * their own /v3/banks/NG endpoint. Built specifically because the
 * "Configure Settlement Account" admin modal had a free-text Bank
 * Code field with no way to look up the correct code — David typed
 * something that wasn't a real bank code and Flutterwave correctly
 * rejected it. This powers a proper dropdown instead, so a wrong code
 * becomes structurally impossible rather than something to catch
 * after the fact.
 *
 * Read-only reference data, same as mfb-list.js — no auth required.
 */
'use strict';

const { corsOrigin } = require('../../lib/cors');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin(event) };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: hdr, body: '' };
  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const secretKey = process.env.FLW_V3_SECRET_KEY;
  if (!secretKey) return err(500, 'FLW_V3_SECRET_KEY not configured');

  try {
    const res = await fetch('https://api.flutterwave.com/v3/banks/NG', {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    const flwData = await res.json();
    if (flwData.status !== 'success') return err(502, `Flutterwave rejected the bank list request: ${flwData.message || 'unknown error'}`);

    const banks = (flwData.data || [])
      .map(b => ({ code: b.code, name: b.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return ok({ banks });
  } catch (e) {
    return err(502, `Failed to reach Flutterwave: ${e.message}`);
  }
};
