/**
 * zillion/backend/tests/test-ajo-two-tier-commission.js
 *
 * Two-tier agent commission: a recruiting agent's override on their sub-agent's own commission
 * (lib/ajoCommission.js), and the depth-2 cap that keeps the hierarchy from ever growing a third tier
 * (lib/ajoAgentHierarchy.js). Override is additive throughout — the sub-agent's own earnings row is never
 * reduced by having a parent.
 * Run: node backend/tests/test-ajo-two-tier-commission.js
 */
'use strict';
const path = require('path');
const LIB = path.join(__dirname, '..', 'lib');
const { makeDb } = require('./helpers/fakeDb');
const { creditAgentCommissionIfApplicable, DEFAULT_TIER2_OVERRIDE_BPS } = require(path.join(LIB, 'ajoCommission'));
const { checkParentEligible } = require(path.join(LIB, 'ajoAgentHierarchy'));

let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };

const attributedNow = new Date().toISOString();

// ────────────────────────────── creditAgentCommissionIfApplicable: tier-1 only (no parent) ──────────────────────────────
(async () => {
  const db = makeDb({
    ajo_referral_attributions: [{ id: 'attr1', scheme_id: 'S1', agent_id: 'A1', attributed_at: attributedNow }],
    ajo_agents: [{ id: 'A1', commission_rate_bps: 3000, parent_agent_id: null, tier2_override_bps: null }],
    ajo_agent_earnings: [],
  });

  const commission = await creditAgentCommissionIfApplicable(db, 'S1', 1000, 'contribution', 'c1');
  ok('tier-1 only: returns the direct agent\'s own commission (30% of 1000 = 300)', commission === 300);
  ok('tier-1 only: exactly one earnings row written (no parent, no tier-2 row)', db.tables.ajo_agent_earnings.length === 1);
  ok('tier-1 only: the row is tagged tier 1', db.tables.ajo_agent_earnings[0].tier === 1);
  ok('tier-1 only: credited to the direct agent', db.tables.ajo_agent_earnings[0].agent_id === 'A1');
})();

// ────────────────────────────── with a parent: default override rate ──────────────────────────────
(async () => {
  const db = makeDb({
    ajo_referral_attributions: [{ id: 'attr1', scheme_id: 'S1', agent_id: 'CHILD', attributed_at: attributedNow }],
    ajo_agents: [
      { id: 'PARENT', commission_rate_bps: 3000, parent_agent_id: null, tier2_override_bps: null },
      { id: 'CHILD', commission_rate_bps: 3000, parent_agent_id: 'PARENT', tier2_override_bps: null },
    ],
    ajo_agent_earnings: [],
  });

  const commission = await creditAgentCommissionIfApplicable(db, 'S1', 1000, 'contribution', 'c1');
  ok('with parent: return value is still just the child\'s own tier-1 commission (300)', commission === 300);
  ok('with parent: TWO earnings rows written (tier 1 for child, tier 2 override for parent)', db.tables.ajo_agent_earnings.length === 2);

  const tier1Row = db.tables.ajo_agent_earnings.find(e => e.tier === 1);
  const tier2Row = db.tables.ajo_agent_earnings.find(e => e.tier === 2);
  ok('with parent: child\'s tier-1 row is untouched — NOT reduced by the override (still 300)', tier1Row.commission_kobo === 300 && tier1Row.agent_id === 'CHILD');
  ok('with parent: parent gets a tier-2 row at the default rate (10% of 300 = 30)', tier2Row.commission_kobo === Math.round(300 * DEFAULT_TIER2_OVERRIDE_BPS / 10000) && tier2Row.agent_id === 'PARENT');
  ok('with parent: tier-2 row records which sub-agent it came from', tier2Row.downline_agent_id === 'CHILD');
  ok('with parent: tier-2 row shares the same attribution and source event as tier-1', tier2Row.attribution_id === 'attr1' && tier2Row.source_event_id === 'c1');
})();

// ────────────────────────────── with a parent: custom override rate ──────────────────────────────
(async () => {
  const db = makeDb({
    ajo_referral_attributions: [{ id: 'attr1', scheme_id: 'S1', agent_id: 'CHILD', attributed_at: attributedNow }],
    ajo_agents: [
      { id: 'PARENT', commission_rate_bps: 3000, parent_agent_id: null, tier2_override_bps: null },
      { id: 'CHILD', commission_rate_bps: 3000, parent_agent_id: 'PARENT', tier2_override_bps: 2000 }, // 20% override, not the 10% default
    ],
    ajo_agent_earnings: [],
  });

  await creditAgentCommissionIfApplicable(db, 'S1', 1000, 'contribution', 'c1');
  const tier2Row = db.tables.ajo_agent_earnings.find(e => e.tier === 2);
  ok('custom override rate: parent gets 20% of 300 = 60, not the 10% default', tier2Row.commission_kobo === 60);
})();

// ────────────────────────────── past the 24-month window: no commission at all, parent included ──────────────────────────────
(async () => {
  const oldAttribution = new Date(Date.now() - 25 * 30 * 24 * 3600 * 1000).toISOString();
  const db = makeDb({
    ajo_referral_attributions: [{ id: 'attr1', scheme_id: 'S1', agent_id: 'CHILD', attributed_at: oldAttribution }],
    ajo_agents: [
      { id: 'PARENT', commission_rate_bps: 3000, parent_agent_id: null, tier2_override_bps: null },
      { id: 'CHILD', commission_rate_bps: 3000, parent_agent_id: 'PARENT', tier2_override_bps: null },
    ],
    ajo_agent_earnings: [],
  });

  const commission = await creditAgentCommissionIfApplicable(db, 'S1', 1000, 'contribution', 'c1');
  ok('past commission window: nothing credited at all, not even a tier-2 override', commission === 0 && db.tables.ajo_agent_earnings.length === 0);
})();

// ────────────────────────────── checkParentEligible: depth-2 cap ──────────────────────────────
(async () => {
  const db = makeDb({
    ajo_agents: [
      { id: 'TOP', parent_agent_id: null },
      { id: 'MIDDLE', parent_agent_id: 'TOP' },
      { id: 'HAS_CHILDREN', parent_agent_id: null },
      { id: 'ITS_CHILD', parent_agent_id: 'HAS_CHILDREN' },
      { id: 'FRESH', parent_agent_id: null },
    ],
  });

  const r1 = await checkParentEligible(db, 'TOP', 'FRESH');
  ok('checkParentEligible: a top-level agent (no parent of their own) is a valid parent', r1.ok === true);

  const r2 = await checkParentEligible(db, 'MIDDLE', 'FRESH');
  ok('checkParentEligible: rejects a proposed parent who already has a parent (would make 3 tiers)', /already has a parent/.test(r2.error));

  const r3 = await checkParentEligible(db, 'TOP', 'HAS_CHILDREN');
  ok('checkParentEligible: rejects giving a parent to an agent who already has sub-agents (would make 3 tiers the other way)', /already has sub-agents/.test(r3.error));

  const r4 = await checkParentEligible(db, 'FRESH', 'FRESH');
  ok('checkParentEligible: an agent cannot be their own parent', /cannot be their own parent/.test(r4.error));

  const r5 = await checkParentEligible(db, 'does-not-exist', 'FRESH');
  ok('checkParentEligible: rejects a parent_agent_id that does not exist', /does not exist/.test(r5.error));

  const r6 = await checkParentEligible(db, 'TOP', null);
  ok('checkParentEligible: creation case (selfAgentId null) only checks the parent side, not skipped entirely', r6.ok === true);
})();

process.on('exit', () => { if (!bad) console.log('\nAll two-tier commission tests passed.'); });
