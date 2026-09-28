/**
 * zillion/backend/lib/coopReference.js
 *
 * The savings, dues, share and loan-repayment ledgers each have a GLOBAL unique index on `reference`
 * (where it is not null). That is what makes payment notifications idempotent - but it also means any code that writes
 * the same reference twice works exactly ONCE and then fails. Four paths did: monthly savings interest ("Monthly
 * interest - <package>" for every plan), repay-from-savings ("Applied to loan <id>", "From savings plan <id>", and a
 * fixed reversal note) and the offline repayment (one fixed sentence for the whole platform). Each failed silently or
 * with a raw duplicate-key error on its second use.
 *
 * uniqueReference keeps the readable label and adds a timestamp and a random suffix, so a reference written for a
 * one-off event can never collide. Where a reference should instead be DETERMINISTIC (so the database itself stops a
 * double credit), build it from the identifiers that define "the same event" - see monthlyInterestReference.
 */
'use strict';

const crypto = require('crypto');

function uniqueReference(label, now = new Date()) {
  return `${label} · ${now.toISOString().slice(0, 19).replace('T', ' ')} · ${crypto.randomBytes(4).toString('hex')}`;
}

/** One interest credit per plan per calendar month - identical inputs give the identical reference, so a repeat is rejected by the database. */
function monthlyInterestReference(pkgName, planId, now) {
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return `Monthly interest — ${pkgName} (${ym}) · plan ${planId}`;
}

module.exports = { uniqueReference, monthlyInterestReference };
