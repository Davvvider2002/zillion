/**
 * zillion/backend/lib/coopStatutoryDeductions.js
 *
 * Nigerian PAYE, pension, NHF and NSITF calculations for payroll.
 * Every rate and band is read from coop_statutory_config and
 * coop_paye_bands - platform-wide, editable tables, never hardcoded
 * constants - so they can be updated whenever the underlying law
 * changes, without a code deployment. Seeded with the current
 * (2020 Finance Act) rates as of this build.
 *
 * PAYE is computed the standard way: annualize the monthly figures,
 * apply the Consolidated Relief Allowance and pension/NHF deductions
 * (both tax-deductible) to get taxable income, apply the progressive
 * bands to that, then divide the result back down to a monthly figure.
 *
 * This is genuinely compliance-sensitive - a wrong calculation here
 * has real legal/financial consequences for whoever relies on it, not
 * just a bug. The banded tax logic is deliberately split into its own
 * pure, synchronous function (computePayeFromTaxableIncome) so it can
 * be tested in isolation with hand-verified numbers, independent of
 * the database-reading wrapper around it.
 */
'use strict';

async function getStatutoryConfig(db) {
  const { data } = await db.from('coop_statutory_config').select('config_key, config_value_numeric');
  const map = {};
  for (const row of (data || [])) map[row.config_key] = Number(row.config_value_numeric);
  return map;
}

async function getPayeBands(db) {
  const { data } = await db.from('coop_paye_bands')
    .select('band_order, band_size_kobo, rate_percent')
    .eq('active', true)
    .order('band_order', { ascending: true });
  return data || [];
}

/**
 * Pure function - applies Nigeria's progressive PAYE bands to a given
 * taxable annual income. band_size_kobo === null means "this band
 * covers everything remaining" (only valid for the final/top band).
 *
 * @param {number} taxableAnnualKobo
 * @param {Array<{band_size_kobo: number|null, rate_percent: number}>} bands  in order
 * @returns {number} total annual tax, in kobo
 */
function computePayeFromTaxableIncome(taxableAnnualKobo, bands) {
  let remaining = Math.max(0, taxableAnnualKobo);
  let totalTaxKobo = 0;
  for (const band of bands) {
    if (remaining <= 0) break;
    const bandAmount = band.band_size_kobo === null ? remaining : Math.min(remaining, band.band_size_kobo);
    totalTaxKobo += Math.round(bandAmount * (band.rate_percent / 100));
    remaining -= bandAmount;
  }
  return totalTaxKobo;
}

/**
 * Full monthly statutory deduction set for one employee.
 *
 * @param {object} db
 * @param {{ grossMonthlyKobo: number, basicMonthlyKobo: number }} pay
 * @returns {Promise<{ payeKobo, pensionEmployeeKobo, pensionEmployerKobo, nhfKobo, nsitfKobo }>}  all monthly
 */
async function computeMonthlyStatutoryDeductions(db, { grossMonthlyKobo, basicMonthlyKobo }) {
  const config = await getStatutoryConfig(db);
  const bands = await getPayeBands(db);

  const grossAnnualKobo = grossMonthlyKobo * 12;
  const basicAnnualKobo = basicMonthlyKobo * 12;

  // Pension and NHF are calculated on basic salary specifically (this
  // config approximates "basic + housing + transport" as basic alone,
  // documented plainly in the seed data's own description field).
  const pensionEmployeeAnnualKobo = Math.round(basicAnnualKobo * (config.pension_employee_percent / 100));
  const pensionEmployerAnnualKobo = Math.round(basicAnnualKobo * (config.pension_employer_percent / 100));
  const nhfAnnualKobo = Math.round(basicAnnualKobo * (config.nhf_percent / 100));
  const nsitfAnnualKobo = Math.round(grossAnnualKobo * (config.nsitf_percent / 100));

  // CRA = the HIGHER of a flat amount or a percent of gross, plus a
  // separate additional percent of gross always added on top.
  const craPercentPartKobo = Math.round(grossAnnualKobo * (config.cra_percent_of_gross / 100));
  const craBaseKobo = Math.max(config.cra_flat_amount_kobo, craPercentPartKobo);
  const craAdditionalKobo = Math.round(grossAnnualKobo * (config.cra_additional_percent / 100));
  const totalCraKobo = craBaseKobo + craAdditionalKobo;

  // Pension and NHF are tax-deductible before PAYE bands apply.
  const taxableAnnualKobo = Math.max(0, grossAnnualKobo - totalCraKobo - pensionEmployeeAnnualKobo - nhfAnnualKobo);
  const annualPayeKobo = computePayeFromTaxableIncome(taxableAnnualKobo, bands);

  return {
    payeKobo: Math.round(annualPayeKobo / 12),
    pensionEmployeeKobo: Math.round(pensionEmployeeAnnualKobo / 12),
    pensionEmployerKobo: Math.round(pensionEmployerAnnualKobo / 12),
    nhfKobo: Math.round(nhfAnnualKobo / 12),
    nsitfKobo: Math.round(nsitfAnnualKobo / 12),
  };
}

module.exports = { computePayeFromTaxableIncome, computeMonthlyStatutoryDeductions, getStatutoryConfig, getPayeBands };
