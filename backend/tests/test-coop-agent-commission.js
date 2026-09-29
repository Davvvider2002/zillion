/**
 * zillion/backend/tests/test-coop-agent-commission.js
 *
 * Coop agent commission: an agent recruits a cooperative society onto the Coop SaaS subscription and earns a
 * share of that society's subscription payments — corrected from an earlier, wrong scoping where this was
 * tied to Ajo scheme fees instead. Two-tier override and the depth-2 cap work exactly as before, just against
 * coop_agents/coop_referral_attributions/coop_agent_earnings and coop_id instead of the old ajo_* tables and
 * scheme_id.
 * Run: node backend/tests/test-coop-agent-commission.js
 */
'use strict';
const path = require('path');
const LIB = path.join(__dirname, '..', 'lib');
const { makeDb } = require('./helpers/fakeDb');
const { creditAgentCommissionIfApplicable, DEFAULT_TIER2_OVERRIDE_BPS } = require(path.join(LIB, 'coopAgentCommission'));
const { checkParentEligible } = require(path.join(LIB, 'coopAgentHierarchy'));

let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };

const attributedNow = new Date().toISOString();

// ────────────────────────────── creditAgentCommissionIfApplicable: tier-1 only (no parent) ──────────────────────────────
(async () => {
  const db = makeDb({
    coop_referral_attributions: [{ id: 'attr1', coop_id: 'COOPSOC-001', agent_id: 'A1', attributed_at: attributedNow }],
    coop_agents: [{ id: 'A1', commission_rate_bps: 3000, parent_agent_id: null, tier2_override_bps: null }],
    coop_agent_earnings: [],
  });

  const commission = await creditAgentCommissionIfApplicable(db, 'COOPSOC-001', 10000, 'pay1');
  ok('tier-1 only: returns the direct agent\'s own commission (30% of a 10000 kobo subscription payment = 3000)', commission === 3000);
  ok('tier-1 only: exactly one earnings row written (no parent, no tier-2 row)', db.tables.coop_agent_earnings.length === 1);
  ok('tier-1 only: the row is tagged tier 1', db.tables.coop_agent_earnings[0].tier === 1);
  ok('tier-1 only: credited to the direct agent', db.tables.coop_agent_earnings[0].agent_id === 'A1');
  ok('tier-1 only: source_fee_event_type is subscription_payment (never contribution/payout - agents earn from Coop, not Ajo)', db.tables.coop_agent_earnings[0].source_fee_event_type === 'subscription_payment');
})();

// ────────────────────────────── a society never referred by any agent ──────────────────────────────
(async () => {
  const db = makeDb({
    coop_referral_attributions: [],
    coop_agents: [],
    coop_agent_earnings: [],
  });
  const commission = await creditAgentCommissionIfApplicable(db, 'COOPSOC-999', 10000, 'pay1');
  ok('no attribution: a society with no referring agent credits nothing at all', commission === 0 && db.tables.coop_agent_earnings.length === 0);
})();

// ────────────────────────────── with a parent: default override rate ──────────────────────────────
(async () => {
  const db = makeDb({
    coop_referral_attributions: [{ id: 'attr1', coop_id: 'COOPSOC-001', agent_id: 'CHILD', attributed_at: attributedNow }],
    coop_agents: [
      { id: 'PARENT', commission_rate_bps: 3000, parent_agent_id: null, tier2_override_bps: null },
      { id: 'CHILD', commission_rate_bps: 3000, parent_agent_id: 'PARENT', tier2_override_bps: null },
    ],
    coop_agent_earnings: [],
  });

  const commission = await creditAgentCommissionIfApplicable(db, 'COOPSOC-001', 10000, 'pay1');
  ok('with parent: return value is still just the child\'s own tier-1 commission (3000)', commission === 3000);
  ok('with parent: TWO earnings rows written (tier 1 for child, tier 2 override for parent)', db.tables.coop_agent_earnings.length === 2);

  const tier1Row = db.tables.coop_agent_earnings.find(e => e.tier === 1);
  const tier2Row = db.tables.coop_agent_earnings.find(e => e.tier === 2);
  ok('with parent: child\'s tier-1 row is untouched — NOT reduced by the override (still 3000)', tier1Row.commission_kobo === 3000 && tier1Row.agent_id === 'CHILD');
  ok('with parent: parent gets a tier-2 row at the default rate (10% of 3000 = 300)', tier2Row.commission_kobo === Math.round(3000 * DEFAULT_TIER2_OVERRIDE_BPS / 10000) && tier2Row.agent_id === 'PARENT');
  ok('with parent: tier-2 row records which sub-agent it came from', tier2Row.downline_agent_id === 'CHILD');
  ok('with parent: tier-2 row shares the same attribution and source event as tier-1', tier2Row.attribution_id === 'attr1' && tier2Row.source_event_id === 'pay1');
})();

// ────────────────────────────── with a parent: custom override rate ──────────────────────────────
(async () => {
  const db = makeDb({
    coop_referral_attributions: [{ id: 'attr1', coop_id: 'COOPSOC-001', agent_id: 'CHILD', attributed_at: attributedNow }],
    coop_agents: [
      { id: 'PARENT', commission_rate_bps: 3000, parent_agent_id: null, tier2_override_bps: null },
      { id: 'CHILD', commission_rate_bps: 3000, parent_agent_id: 'PARENT', tier2_override_bps: 2000 },
    ],
    coop_agent_earnings: [],
  });

  await creditAgentCommissionIfApplicable(db, 'COOPSOC-001', 10000, 'pay1');
  const tier2Row = db.tables.coop_agent_earnings.find(e => e.tier === 2);
  ok('custom override rate: parent gets 20% of 3000 = 600, not the 10% default', tier2Row.commission_kobo === 600);
})();

// ────────────────────────────── past the 24-month window: nothing at all, parent included ──────────────────────────────
(async () => {
  const oldAttribution = new Date(Date.now() - 25 * 30 * 24 * 3600 * 1000).toISOString();
  const db = makeDb({
    coop_referral_attributions: [{ id: 'attr1', coop_id: 'COOPSOC-001', agent_id: 'CHILD', attributed_at: oldAttribution }],
    coop_agents: [
      { id: 'PARENT', commission_rate_bps: 3000, parent_agent_id: null, tier2_override_bps: null },
      { id: 'CHILD', commission_rate_bps: 3000, parent_agent_id: 'PARENT', tier2_override_bps: null },
    ],
    coop_agent_earnings: [],
  });

  const commission = await creditAgentCommissionIfApplicable(db, 'COOPSOC-001', 10000, 'pay1');
  ok('past commission window: nothing credited at all, not even a tier-2 override', commission === 0 && db.tables.coop_agent_earnings.length === 0);
})();

// ────────────────────────────── zero-amount payment credits nothing ──────────────────────────────
(async () => {
  const db = makeDb({
    coop_referral_attributions: [{ id: 'attr1', coop_id: 'COOPSOC-001', agent_id: 'A1', attributed_at: attributedNow }],
    coop_agents: [{ id: 'A1', commission_rate_bps: 3000, parent_agent_id: null, tier2_override_bps: null }],
    coop_agent_earnings: [],
  });
  const commission = await creditAgentCommissionIfApplicable(db, 'COOPSOC-001', 0, 'pay1');
  ok('zero-amount payment: credits nothing', commission === 0 && db.tables.coop_agent_earnings.length === 0);
})();

// ────────────────────────────── checkParentEligible: depth-2 cap (against coop_agents) ──────────────────────────────
(async () => {
  const db = makeDb({
    coop_agents: [
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

process.on('exit', () => { if (!bad) console.log('\nAll Coop agent commission tests passed.'); });
