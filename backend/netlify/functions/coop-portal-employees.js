/**
 * zillion/backend/netlify/functions/coop-portal-employees.js
 *
 * GET  /api/v1/coop-portal-employees
 * POST /api/v1/coop-portal-employees   { action: 'create'|'update'|'terminate'|'set_salary', ... }
 *
 * Employee records for the society's own paid staff - distinct from
 * coop_members (a member never automatically becomes an employee, and
 * vice versa). member_id links the two only when a staff member is
 * genuinely also a cooperative member, so the platform can tell the
 * two apart even for the same person.
 *
 * Salary is effective-dated, not overwritten in place: set_salary
 * deactivates the employee's current components and inserts a fresh
 * set with today as effective_from, so salary history survives a
 * raise or restructuring rather than being silently lost.
 *
 * Gated behind the HR & Payroll add-on.
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety } = require('../../lib/coopPortalAuth');
const { hasAddon }             = require('../../lib/coopEntitlements');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');

  const db = getServiceClient();
  const resolved = await resolvePortalSociety(db, auth);
  if (!resolved.ok) return err(resolved.status, resolved.error);
  const coopId = resolved.society.coop_id;

  if (!(await hasAddon(db, coopId, 'payroll'))) {
    return err(403, 'HR & Payroll is not enabled for this society. Add it from the Add-ons tab.');
  }

  if (event.httpMethod === 'GET') {
    const { data: employees } = await db.from('coop_employees')
      .select('id, name, job_title, email, phone, employment_date, status, member_id, coop_members(name)')
      .eq('coop_id', coopId).order('employment_date', { ascending: false });

    const withSalary = await Promise.all((employees || []).map(async (e) => {
      const { data: components } = await db.from('coop_employee_salary_components')
        .select('component_type, component_name, amount_kobo').eq('employee_id', e.id).eq('active', true);
      const basic = (components || []).find(c => c.component_type === 'basic');
      const allowances = (components || []).filter(c => c.component_type === 'allowance');
      const gross_kobo = (components || []).reduce((s, c) => s + c.amount_kobo, 0);
      return { ...e, member_name: e.coop_members?.name || null, basic_salary_kobo: basic?.amount_kobo || 0, allowances, gross_kobo };
    }));

    return ok({ employees: withSalary });
  }

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  if (body.action === 'create') {
    const name = (body.name || '').trim();
    if (!name) return err(400, 'name is required');
    if (!body.employment_date) return err(400, 'employment_date is required');

    let memberId = null;
    if (body.member_id) {
      const { data: member } = await db.from('coop_members').select('id').eq('id', body.member_id).eq('coop_id', coopId).maybeSingle();
      if (!member) return err(400, 'That member does not belong to this society');
      memberId = member.id;
    }

    const { data: created, error: insertErr } = await db.from('coop_employees').insert({
      coop_id: coopId, member_id: memberId, name,
      job_title: body.job_title || null, email: body.email || null, phone: body.phone || null,
      bank_name: body.bank_name || null, bank_account_number: body.bank_account_number || null,
      tin: body.tin || null, pension_rsa_number: body.pension_rsa_number || null,
      employment_date: body.employment_date,
    }).select().single();
    if (insertErr) return err(500, `Failed to create employee: ${insertErr.message}`);

    if (body.basic_salary_kobo) {
      await insertSalaryComponents(db, created.id, body.basic_salary_kobo, body.allowances || []);
    }
    return ok({ success: true, employee: created });
  }

  if (body.action === 'update') {
    if (!body.employee_id) return err(400, 'employee_id is required');
    const { data: updated, error: updateErr } = await db.from('coop_employees')
      .update({
        name: body.name, job_title: body.job_title, email: body.email, phone: body.phone,
        bank_name: body.bank_name, bank_account_number: body.bank_account_number,
        tin: body.tin, pension_rsa_number: body.pension_rsa_number,
      })
      .eq('id', body.employee_id).eq('coop_id', coopId).select().maybeSingle();
    if (updateErr) return err(500, `Failed to update: ${updateErr.message}`);
    if (!updated) return err(404, 'Employee not found in your society');
    return ok({ success: true, employee: updated });
  }

  if (body.action === 'terminate') {
    if (!body.employee_id) return err(400, 'employee_id is required');
    const { data: updated, error: updateErr } = await db.from('coop_employees')
      .update({ status: 'TERMINATED', termination_date: body.termination_date || new Date().toISOString().slice(0, 10) })
      .eq('id', body.employee_id).eq('coop_id', coopId).select().maybeSingle();
    if (updateErr) return err(500, `Failed to terminate: ${updateErr.message}`);
    if (!updated) return err(404, 'Employee not found in your society');
    return ok({ success: true, employee: updated });
  }

  if (body.action === 'set_salary') {
    if (!body.employee_id) return err(400, 'employee_id is required');
    if (!Number.isInteger(body.basic_salary_kobo) || body.basic_salary_kobo <= 0) {
      return err(400, 'basic_salary_kobo must be a positive integer');
    }
    const { data: employee } = await db.from('coop_employees').select('id').eq('id', body.employee_id).eq('coop_id', coopId).maybeSingle();
    if (!employee) return err(404, 'Employee not found in your society');

    // Deactivate current components rather than delete them - salary
    // history stays intact for anyone looking back at a past payroll run.
    await db.from('coop_employee_salary_components').update({ active: false }).eq('employee_id', body.employee_id).eq('active', true);
    await insertSalaryComponents(db, body.employee_id, body.basic_salary_kobo, body.allowances || []);

    return ok({ success: true });
  }

  return err(400, `Unknown action "${body.action}". Use: create, update, terminate, set_salary`);
};

async function insertSalaryComponents(db, employeeId, basicSalaryKobo, allowances) {
  const today = new Date().toISOString().slice(0, 10);
  const rows = [
    { employee_id: employeeId, component_type: 'basic', component_name: 'Basic Salary', amount_kobo: basicSalaryKobo, effective_from: today },
    ...allowances
      .filter(a => a && a.name && Number.isInteger(a.amount_kobo) && a.amount_kobo > 0)
      .map(a => ({ employee_id: employeeId, component_type: 'allowance', component_name: a.name, amount_kobo: a.amount_kobo, effective_from: today })),
  ];
  await db.from('coop_employee_salary_components').insert(rows);
}
