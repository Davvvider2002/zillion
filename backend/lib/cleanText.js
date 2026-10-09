/**
 * zillion/backend/lib/cleanText.js
 *
 * Server-side cleaning of free text typed by people we do not control (public join forms, society sign-up, agent
 * applications). This is defence in depth for the XSS findings: the front-ends also escape on output, but a stored
 * "<img onerror=...>" in a member name must never reach a database row in the first place.
 *
 * It removes control characters and the characters that open or close markup and attributes (< > " ` and backslash),
 * collapses whitespace and caps the length. Apostrophes, hyphens, full stops and accented letters are kept, so real
 * names such as O'Brien, Adeyemi-Smith and Chukwuemeka survive.
 */
'use strict';

const MARKUP_CHARS = /[<>"`\\]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp('['+'\\u0000-\\u001F\\u007F-\\u009F\\u2028\\u2029\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069'+']', 'g');

function cleanText(value, maxLen = 120) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(CONTROL_CHARS, ' ')
    .replace(MARKUP_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

module.exports = { cleanText };
