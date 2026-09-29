-- Index audit: 23 foreign-key columns on coop_* tables had no supporting index (Postgres never creates these
-- automatically). Cheap and zero-risk to add now while every table is small (largest coop table today: 212
-- rows) — expensive to add later under load, and the coop_id columns here are the filter on nearly every query
-- in the codebase. Applied to staging then production, both verified clean (0 unindexed FK columns remaining).
CREATE INDEX IF NOT EXISTS idx_coop_checkout_sessions_coop_id ON coop_checkout_sessions(coop_id);
CREATE INDEX IF NOT EXISTS idx_coop_checkout_sessions_loan_id ON coop_checkout_sessions(loan_id);
CREATE INDEX IF NOT EXISTS idx_coop_checkout_sessions_savings_plan_id ON coop_checkout_sessions(savings_plan_id);
CREATE INDEX IF NOT EXISTS idx_coop_dues_transactions_coop_id ON coop_dues_transactions(coop_id);
CREATE INDEX IF NOT EXISTS idx_coop_financial_years_closing_entry_id ON coop_financial_years(closing_entry_id);
CREATE INDEX IF NOT EXISTS idx_coop_join_applications_coop_member_id ON coop_join_applications(coop_member_id);
CREATE INDEX IF NOT EXISTS idx_coop_kyc_verifications_invoice_id ON coop_kyc_verifications(invoice_id);
CREATE INDEX IF NOT EXISTS idx_coop_loans_coop_id ON coop_loans(coop_id);
CREATE INDEX IF NOT EXISTS idx_coop_loans_loan_package_id ON coop_loans(loan_package_id);
CREATE INDEX IF NOT EXISTS idx_coop_loans_savings_plan_id ON coop_loans(savings_plan_id);
CREATE INDEX IF NOT EXISTS idx_coop_member_investments_coop_id ON coop_member_investments(coop_id);
CREATE INDEX IF NOT EXISTS idx_coop_notification_reads_member_id ON coop_notification_reads(member_id);
CREATE INDEX IF NOT EXISTS idx_coop_notifications_target_member_id ON coop_notifications(target_member_id);
CREATE INDEX IF NOT EXISTS idx_coop_payroll_run_lines_employee_id ON coop_payroll_run_lines(employee_id);
CREATE INDEX IF NOT EXISTS idx_coop_reconciliation_unmatched_batch_id ON coop_reconciliation_unmatched_records(batch_id);
CREATE INDEX IF NOT EXISTS idx_coop_savings_plans_coop_id ON coop_savings_plans(coop_id);
CREATE INDEX IF NOT EXISTS idx_coop_savings_plans_savings_package_id ON coop_savings_plans(savings_package_id);
CREATE INDEX IF NOT EXISTS idx_coop_savings_transactions_coop_id ON coop_savings_transactions(coop_id);
CREATE INDEX IF NOT EXISTS idx_coop_society_addons_addon_key ON coop_society_addons(addon_key);
CREATE INDEX IF NOT EXISTS idx_coop_staff_loan_repayments_payroll_run_id ON coop_staff_loan_repayments(payroll_run_id);
CREATE INDEX IF NOT EXISTS idx_coop_staff_loans_coop_id ON coop_staff_loans(coop_id);
CREATE INDEX IF NOT EXISTS idx_coop_bank_reconciliation_batches_bank_account_id ON coop_bank_reconciliation_batches(bank_account_id);
CREATE INDEX IF NOT EXISTS idx_coop_bank_statement_lines_resolved_journal_entry_id ON coop_bank_statement_lines(resolved_journal_entry_id);
