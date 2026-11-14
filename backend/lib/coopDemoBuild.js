/**
 * zillion/backend/lib/coopDemoBuild.js
 * Builds and resets the demo cooperative. See coopDemo.js for the design. Runs for a few minutes, so it is started from
 * a Netlify background function; progress is written to demo_society_state so the admin page can show it.
 *
 * Every step after the society and its members is "soft": if one feature's endpoint refuses, that step is recorded in the
 * log and the build carries on, so one changed rule never stops the whole demo from being built.
 */
'use strict';

const D = require('./coopDemo');
const { createBackup, restoreSociety } = require('./coopBackup');

const fn = name => require('../netlify/functions/' + name).handler;

async function buildDemoSociety(db, { env = process.env, actor = 'demo-builder', log: external = () => {} } = {}) {
  const lines = [];
  const log = m => { lines.push(m); external(m); };
  const plan = D.demoPlan();
  await D.saveState(db, { status: 'building', status_detail: 'Starting', last_error: null, build_log: '' });
  const progress = async m => { log(m); await D.saveState(db, { status: 'building', status_detail: m, build_log: lines.join('\n').slice(-6000) }); };

  try {
    const admin = D.signToken({ sub: actor, username: actor, role: 'SUPER_ADMIN' }, env);
    let coopId;

    // 1. The society. Re-use it if it already exists (a rebuild), otherwise create it through the real admin endpoint.
    let { data: society } = await db.from('coop_societies').select('coop_id').eq('merchant_id', D.DEMO.merchantId).maybeSingle();
    if (!society) {
      await progress('Creating the society');
      const r = await D.call(fn('admin-create-coop-society'), admin, {
        name: D.DEMO.name, phone: D.DEMO.adminPhoneLocal, owner_name: D.DEMO.ownerName, location: D.DEMO.location,
        password: D.demoPassword(env), primary_industry: 'Other', country: 'Nigeria', base_currency: 'NGN', financial_year_start_month: 1,
      });
      if (r.status !== 200) throw new Error('Could not create the society: ' + (r.body.error || r.status));
      coopId = r.body.society.coop_id;
    } else coopId = society.coop_id;
    await D.reassertDemoSettings(db, coopId, env);

    // every add-on switched on, so every feature can be shown
    const { data: mods } = await db.from('coop_addon_modules').select('key');
    if (mods && mods.length) {
      await db.from('coop_society_addons').delete().eq('coop_id', coopId);
      await db.from('coop_society_addons').insert(mods.map(m => ({ coop_id: coopId, addon_key: m.key })));
    }
    log(`Society ${coopId} ready with ${(mods || []).length} add-ons`);

    const tok = D.signToken({ sub: D.DEMO.merchantId, merchant_id: D.DEMO.merchantId, phone: D.DEMO.adminPhone, role: 'merchant', business_name: D.DEMO.name, owner_name: D.DEMO.ownerName }, env);
    const soft = async (label, f) => { try { await progress(label); await f(); } catch (e) { log(`  SKIPPED ${label}: ${e.message}`); } };
    const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.body.error || r.status}`); return r.body; };
    const post = (name, body) => D.call(fn(name), tok, body);

    // 2. Society rules
    await soft('Setting joining fee, dues, loan interest and guarantors', async () => {
      must(await post('coop-portal-configure-joining-fee', { joining_fee_kobo: D.naira(5000) }), 'joining fee');
      must(await post('coop-portal-configure-dues', { dues_amount_kobo: D.naira(2000), dues_frequency: 'monthly', dues_enforcement_enabled: false }), 'dues');
      must(await post('coop-portal-configure-loan-interest', { loan_interest_enabled: true, loan_interest_rate_percent: 10 }), 'loan interest');
      must(await post('coop-portal-configure-guarantors', { required_guarantor_count: 1 }), 'guarantors');
    });
    await soft('Creating savings and loan packages', async () => {
      must(await post('coop-portal-savings-packages', { action: 'create', name: 'Standard Savings', monthly_interest_rate_percent: 0.5 }), 'savings package');
      must(await post('coop-portal-savings-packages', { action: 'create', name: 'Fixed Plus', monthly_interest_rate_percent: 1, min_balance_kobo: D.naira(100000) }), 'savings package');
      must(await post('coop-portal-loan-packages', { action: 'create', name: 'Standard Loan', calculation_type: 'multiplier_of_savings', multiplier_value: 3, default_repayment_months: 12, interest_method: 'flat' }), 'loan package');
      must(await post('coop-portal-loan-packages', { action: 'create', name: 'Emergency Loan', calculation_type: 'flat_max', flat_max_kobo: D.naira(500000), default_repayment_months: 6, interest_method: 'flat' }), 'loan package');
    });
    const { data: sPk } = await db.from('coop_savings_packages').select('id, name').eq('coop_id', coopId);
    const { data: lPk } = await db.from('coop_loan_packages').select('id, name').eq('coop_id', coopId);
    const savingsPkg = n => ((sPk || []).find(p => p.name === n) || {}).id;
    const loanPkg = n => ((lPk || []).find(p => p.name === n) || {}).id;

    // 3. Members (critical)
    await progress('Adding members');
    const imp = must(await post('coop-portal-bulk-import', { csv_text: plan.csv }), 'members');
    if (!imp.summary || imp.summary.failed === plan.members.length) throw new Error('No members could be added: ' + JSON.stringify((imp.results || []).slice(0, 2)));
    const { data: rows } = await db.from('coop_members').select('id, name, phone_normalized').eq('coop_id', coopId);
    const byName = new Map((rows || []).map(r => [r.name, r.id]));
    const mid = i => byName.get(plan.members[i].name);
    log(`${(rows || []).length} members on the register`);

    // 4. Savings
    const planIds = new Map();
    await soft('Opening savings plans and recording deposits', async () => {
      for (const s of plan.savingsPlans) {
        const created = await post('coop-portal-create-savings-plan', { member_id: mid(s.member), target_amount_kobo: s.target, monthly_contribution_kobo: s.monthly, duration_months: s.months, savings_package_id: savingsPkg(s.package) });
        if (created.status !== 200) { log(`  savings plan for member ${s.member}: ${created.body.error}`); continue; }
        planIds.set(s.member, created.body.plan.id);
        for (const [k, amt] of s.deposits.entries()) await post('coop-portal-record-savings-payment', { savings_plan_id: created.body.plan.id, amount_kobo: amt, source: 'bank_transfer_manual', reference: `DEMO-SAV-${s.member}-${k}` });
      }
    });
    await soft('Recording share capital', async () => { for (const s of plan.shares) await post('coop-portal-record-share-payment', { member_id: mid(s.member), amount_kobo: s.amount, source: 'bank_transfer_manual', reference: `DEMO-SHR-${s.member}` }); });
    await soft('Recording dues', async () => { for (const d of plan.dues) await post('coop-portal-record-dues-payment', { member_id: mid(d.member), amount_kobo: d.amount, source: 'bank_transfer_manual', reference: `DEMO-DUE-${d.member}` }); });

    // 5. Loans, left at every stage of the workflow
    await soft('Creating loans at every stage', async () => {
      for (const [n, l] of plan.loans.entries()) try {
        const made = await post('coop-portal-create-loan', { member_id: mid(l.member), guarantor_member_ids: [mid(l.guarantor)], principal_kobo: l.principal, repayment_months: l.months, loan_package_id: loanPkg(l.package), savings_plan_id: planIds.get(l.member) });
        if (made.status !== 200) { log(`  loan ${n + 1}: ${made.body.error}`); continue; }
        const loanId = made.body.loan.id;
        if (l.status === 'awaiting_guarantor') continue;
        const { data: g } = await db.from('coop_loan_guarantors').select('id').eq('loan_id', loanId);
        for (const row of g || []) await post('coop-portal-loan-guarantor-override', { guarantor_id: row.id, decision: 'APPROVED', reason: 'Demo data' });
        if (l.status === 'awaiting_approval') continue;
        if (l.status === 'rejected') { await post('coop-portal-loan-action', { loan_id: loanId, action: 'reject', reason: 'Demo data: exceeds the member\'s savings' }); continue; }
        must(await post('coop-portal-loan-action', { loan_id: loanId, action: 'approve' }), `loan ${n + 1} approve`);
        if (l.status === 'approved') continue;
        must(await post('coop-portal-loan-action', { loan_id: loanId, action: 'disburse' }), `loan ${n + 1} disburse`);
        const instalment = Math.round(l.principal * 1.1 / l.months);
        for (let k = 0; k < l.repaid; k++) await post('coop-portal-record-loan-repayment', { loan_id: loanId, amount_kobo: instalment, source: 'bank_transfer_manual', reference: `DEMO-REP-${n}-${k}` });
      } catch (e) { log(`  loan ${n + 1}: ${e.message}`); }
    });

    // 6. Investments, staff, notice
    await soft('Creating an investment product and purchases', async () => {
      const inv = plan.investment;
      must(await post('coop-portal-investment-products', { action: 'create', name: inv.name, product_type: 'general', return_type: 'fixed', unit_price_kobo: inv.unitPrice, tenure_months: inv.tenure, total_units: 200, fixed_return_rate_percent: inv.rate }), 'investment product');
      const { data: prod } = await db.from('coop_investment_products').select('id').eq('coop_id', coopId).eq('name', inv.name).maybeSingle();
      for (const b of inv.buyers) await post('coop-portal-record-investment', { member_id: mid(b.member), product_id: prod.id, units: b.units });
    });
    await soft('Adding employees', async () => {
      for (const e of plan.employees) { const r = await post('coop-portal-employees', { action: 'create', name: e.name, job_title: e.job_title, employment_date: '2025-01-15', basic_salary_kobo: e.basic }); if (r.status !== 200) log(`  employee ${e.name}: ${r.body.error}`); }
    });
    await soft('Sending a welcome notice', async () => { must(await post('coop-portal-send-notification', { title: plan.notification.title, body: plan.notification.body, target_type: 'broadcast' }), 'notice'); });

    // 7. The baseline every reset returns to
    await progress('Saving the baseline');
    const backup = await createBackup(db, { scope: 'society', coopId, kind: 'manual', createdBy: actor, env });
    await D.saveState(db, { status: 'ready', status_detail: 'Ready', society_coop_id: coopId, merchant_id: D.DEMO.merchantId, baseline_backup_id: backup.run.id,
      built_at: new Date().toISOString(), last_reset_at: new Date().toISOString(), reset_every_days: D.DEMO.resetEveryDays, last_error: null, build_log: lines.join('\n').slice(-6000) });
    log('Demo society built');
    return { ok: true, coopId, backupId: backup.run.id, log: lines };
  } catch (e) {
    log('FAILED: ' + e.message);
    await D.saveState(db, { status: 'failed', status_detail: 'Failed', last_error: String(e.message).slice(0, 500), build_log: lines.join('\n').slice(-6000) });
    return { ok: false, error: e.message, log: lines };
  }
}

async function resetDemoSociety(db, { env = process.env, actor = 'demo-reset' } = {}) {
  const state = await D.loadState(db);
  if (!state || !state.baseline_backup_id || !state.society_coop_id) return { ok: false, error: 'The demo society has not been built yet.' };
  const { data: run } = await db.from('backup_runs').select('*').eq('id', state.baseline_backup_id).maybeSingle();
  if (!run || run.status !== 'ok') return { ok: false, error: 'The saved baseline is missing. Build the demo society again.' };
  try {
    await restoreSociety(db, { coopId: state.society_coop_id, societyName: D.DEMO.name, run, apply: true, confirm: `RESTORE ${D.DEMO.name}`, acceptSchemaDrift: true, actor, env });
    await D.reassertDemoSettings(db, state.society_coop_id, env);
    await D.saveState(db, { ...state, status: 'ready', status_detail: 'Reset', last_reset_at: new Date().toISOString(), last_error: null });
    return { ok: true };
  } catch (e) {
    await D.saveState(db, { ...state, status: 'ready', status_detail: 'Last reset failed, data left as it was', last_error: String(e.message).slice(0, 500) });
    return { ok: false, error: e.message };
  }
}

module.exports = { buildDemoSociety, resetDemoSociety };
