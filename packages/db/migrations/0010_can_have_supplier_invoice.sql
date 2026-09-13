ALTER TABLE "transaction_categories" ADD COLUMN "can_have_supplier_invoice" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
-- Teams created before this column existed already hold the whole built-in
-- taxonomy, so the default alone would leave every one of them answering "yes"
-- for its VAT bill. The defaults in `packages/categories` only reach a team at
-- creation; this reaches the ones already there.
--
-- Matched on slug and restricted to the built-in categories, so it cannot flip
-- something a user made and named into the same slug. A team that has renamed
-- one of these keeps `true` — the slug is derived from the name, and there is no
-- id to match on that means anything across teams.
--
-- A category added to the taxonomy later with this answer set to false needs its
-- own migration; nothing links this list to the one in `packages/categories`.
UPDATE "transaction_categories"
SET "can_have_supplier_invoice" = false
WHERE "system" = true
  AND "slug" IN (
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
