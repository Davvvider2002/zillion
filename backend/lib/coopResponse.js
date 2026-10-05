/**
 * zillion/backend/lib/coopResponse.js
 *
 * Responses for endpoints whose payload grows with a society's size (the dashboard sends every member, plan and loan).
 *
 * Netlify functions cannot return more than about 6 MB, and a bigger response doesn't fail politely - the browser just
 * gets a bare 502. Measured: a 5,000-member society's dashboard is ~6.7 MB before enrichment, so past roughly 3,000-4,000
 * members it stops loading. Large responses are gzipped. How much that buys depends on how filled-in the rows are: ~3.7x on
 * fully populated members (unique names, addresses, NIN hashes), far more on sparse ones. Measured on fully populated rows:
 * the plain response fails at ~3,500 members, the compressed one at ~12,000. That is a 3.5x extension, NOT a permanent fix -
 * a society beyond that needs the members list paged and searched on the server.
 *
 * Deliberately conservative, because this is a transport change that can only be fully proven against the live platform:
 *   - at or under COMPRESS_ABOVE_BYTES (4 MB) the response is EXACTLY what it always was - every current society, and
 *     any society that works today, is untouched. Compression only engages where the plain response is at risk anyway.
 *   - it only compresses when the browser says it accepts gzip (every browser does, but we don't assume).
 *   - if the response is too big even compressed, the user gets a clear message instead of a 502.
 *
 * (The 4 MB line sits well below the limit because the response is itself wrapped in JSON, which escapes every quote and
 * inflates the wire size by roughly 10-15%.)
 */
'use strict';

const zlib = require('zlib');

const COMPRESS_ABOVE_BYTES = 4 * 1024 * 1024;
const MAX_WIRE_BYTES = 5.5 * 1024 * 1024;   // hard ceiling with safety margin under the ~6 MB platform limit

function acceptsGzip(event) {
  const h = (event && event.headers) || {};
  return /\bgzip\b/i.test(h['accept-encoding'] || h['Accept-Encoding'] || '');
}

/**
 * @param {object} event   the Netlify event (for Accept-Encoding)
 * @param {object} body    the value to send as JSON
 * @param {object} headers base headers (Content-Type etc.)
 */
function bigJsonResponse(event, body, headers = { 'Content-Type': 'application/json' }) {
  const text = JSON.stringify(body);
  const plainBytes = Buffer.byteLength(text);

  if (plainBytes <= COMPRESS_ABOVE_BYTES) return { statusCode: 200, headers, body: text };

  if (acceptsGzip(event)) {
    const gz = zlib.gzipSync(text);
    const wire = Math.ceil(gz.length * 4 / 3);                        // base64 inflates by a third
    if (wire <= MAX_WIRE_BYTES) {
      return { statusCode: 200, isBase64Encoded: true, body: gz.toString('base64'),
        headers: { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } };
    }
  } else if (plainBytes <= MAX_WIRE_BYTES) {
    return { statusCode: 200, headers, body: text };
  }

  return { statusCode: 413, headers, body: JSON.stringify({
    error: `This society's data (${(plainBytes / 1048576).toFixed(1)} MB) is too large to load in one request. Please contact Zillion support - this needs the paged view enabled for your society.`,
  }) };
}

module.exports = { bigJsonResponse, COMPRESS_ABOVE_BYTES, MAX_WIRE_BYTES };
