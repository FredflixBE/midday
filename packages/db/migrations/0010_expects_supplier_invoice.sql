ALTER TABLE "transaction_categories" ADD COLUMN "expects_supplier_invoice" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
-- Teams created before this column existed already hold the whole built-in
-- taxonomy, so the default alone would leave every one of them answering "yes"
-- for its VAT bill. The defaults in `packages/categories` only reach a team at
-- creation; this reaches the ones already there.
--
-- Matched on slug, which is half the primary key, so it applies to every team at
-- once and touches nothing anybody created themselves.
UPDATE "transaction_categories"
SET "expects_supplier_invoice" = false
WHERE "slug" IN (
  -- Taxes & Government: the parent and every child
  'taxes',
  'vat-gst-pst-qst-payments',
  'sales-use-tax-payments',
  'income-tax-payments',
  'payroll-tax-remittances',
  'employer-taxes',
  'government-fees',
  -- Money moving inside the business, or back to its owner
  'owner-draws',
  'transfer',
  'internal-transfer',
  'credit-card-payment',
  'loan-principal-repayment',
  -- A salary is not a supplier debt
  'salary'
);
