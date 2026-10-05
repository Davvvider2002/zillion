/**
 * zillion/backend/lib/coopSocietyName.js
 *
 * One society name, one live society. The rule itself lives in the database - a unique index over name_key, which a trigger
 * fills from coop_society_name_key(name) (db/migrations/2026-10-05_society_name_unique.sql). That function ignores case,
 * punctuation, spacing and filler words (cooperative, coop, society, ltd, thrift, credit, union ...), so "Doyin Coop",
 * "Doyincoop" and "DOYIN CO-OPERATIVE SOCIETY LTD" are all the same name, while "Doyin Coop Ikeja" is a different one.
 * Archived societies (expired trials) release their name.
 *
 * This file only makes the failure FRIENDLY. The check below is a courtesy that fails open (if it cannot run, the
 * database's own index still refuses the duplicate, and isNameKeyViolation turns that refusal into the same message).
 */
'use strict';

/** @returns {Promise<{conflict:boolean, coopId?:string}>} */
async function findNameConflict(db, name) {
  try {
    const { data: key, error } = await db.rpc('coop_society_name_key', { p: name });
    if (error || !key) return { conflict: false };
    const { data } = await db.from('coop_societies').select('coop_id').eq('name_key', key).is('archived_at', null).limit(1);
    return data && data.length ? { conflict: true, coopId: data[0].coop_id } : { conflict: false };
  } catch (e) {
    console.error('[coopSocietyName] name check failed (the database index still enforces it):', e.message);
    return { conflict: false };
  }
}

/** Safe to show to the public: says nothing about who owns the existing society. */
function nameTakenMessage(name) {
  return `A society called "${name}" is already registered. If that's yours, please log in instead, or contact support. `
    + `If you're a different cooperative, make your name distinct by adding your town or another word, for example "${name} Ikeja".`;
}

/** The database's refusal of a duplicate name (the backstop when two sign-ups race). */
function isNameKeyViolation(error) {
  return !!error && String(error.code) === '23505' && /name_key/.test(`${error.message || ''} ${error.details || ''}`);
}

module.exports = { findNameConflict, nameTakenMessage, isNameKeyViolation };
