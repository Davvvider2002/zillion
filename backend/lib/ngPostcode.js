/**
 * zillion/backend/lib/ngPostcode.js
 *
 * Nigeria's National Digital Alphanumeric Postcode (NIPOST, launched 1 Oct 2026): a building-level code of
 * five segments - State (2 letters), LGA (2 digits), District (3 letters/digits), Area (2 letters), Building
 * unit (2 digits) - e.g. EK-01-A03-FK-01, 11 characters without separators. NIPOST's own prose docs call it
 * "12 characters" while their segments add up to 11, and their examples are all 11, so the segment structure
 * is what this validates; if the format ever changes, this one file is the only place that needs to.
 *
 * FORMAT ONLY. A code that passes here has the right shape - it has NOT been checked against NIPOST's API
 * (that needs a KYB-approved key) and says nothing about whether anyone lives at the building. Callers store
 * it as a self-declared, optional field.
 *
 * Stored canonical form: compact, upper-case, no separators (FC02A09DB09). formatPostcode() re-hyphenates
 * for display and for NIPOST's API, which takes the hyphenated form.
 */
'use strict';

const COMPACT_RE = /^[A-Z]{2}[0-9]{2}[A-Z0-9]{3}[A-Z]{2}[0-9]{2}$/;

/** Strips whitespace/hyphens/dots and upper-cases. Does not validate. */
function compact(raw) {
  return String(raw == null ? '' : raw).replace(/[\s\-._]/g, '').toUpperCase();
}

/**
 * @returns {{ok:true, value:string|null}|{ok:false, error:string}}
 *   An empty/absent input is valid (the field is optional) and yields value:null.
 */
function validateOptionalPostcode(raw) {
  const c = compact(raw);
  if (!c) return { ok: true, value: null };
  if (!COMPACT_RE.test(c)) {
    return { ok: false, error: `"${String(raw).trim()}" is not a valid digital postcode. It should look like FC-02-A09-DB-09 (find yours at postcode.gov.ng), or leave it blank.` };
  }
  return { ok: true, value: c };
}

/** FC02A09DB09 -> FC-02-A09-DB-09. Returns null for anything that isn't a valid compact code. */
function formatPostcode(code) {
  const c = compact(code);
  if (!COMPACT_RE.test(c)) return null;
  return `${c.slice(0, 2)}-${c.slice(2, 4)}-${c.slice(4, 7)}-${c.slice(7, 9)}-${c.slice(9, 11)}`;
}

module.exports = { validateOptionalPostcode, formatPostcode, compact };
