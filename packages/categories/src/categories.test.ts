/**
 * Seam under test: which built-in categories can ever have a supplier invoice.
 *
 * The answer is a default a fresh team gets on day one, and it is the reason
 * Midday stops telling somebody they are missing an invoice for their VAT bill.
 * A typo in one slug here is invisible in the UI and wrong in the count, so the
 * list is asserted whole rather than sampled. FF-1553.
 */
import { expect, test } from "bun:test";
import { CATEGORIES } from "./categories";

/** Every category, parents and children alike, as one flat list. */
const allCategories = CATEGORIES.flatMap((parent) => [parent, ...parent.children]);

test("the categories that can never have a supplier invoice are exactly these", () => {
  const cannot = allCategories
    .filter((category) => !category.expectsSupplierInvoice)
    .map((category) => category.slug)
    .sort();

  expect(cannot).toEqual(
    [
      // Taxes & Government — the parent and every child. A tax office issues an
      // assessment, never a supplier invoice.
      "taxes",
      "vat-gst-pst-qst-payments",
      "sales-use-tax-payments",
      "income-tax-payments",
      "payroll-tax-remittances",
      "employer-taxes",
      "government-fees",
      // Money moving inside the business, or back to its owner.
      "owner-draws",
      "transfer",
      "internal-transfer",
      "credit-card-payment",
      "loan-principal-repayment",
      // A salary is not a supplier debt. The bank says so too: these arrive as
      // ISO 20022 `ICDT/SALA`.
      "salary",
    ].sort(),
  );
});

test("the instructive yes cases stay yes", () => {
  // Leases and insurance do have invoices — the reason they showed up in the
  // missing list was a matching failure, not a classification one (FF-1548).
  const expects = (slug: string) =>
    allCategories.find((category) => category.slug === slug)
      ?.expectsSupplierInvoice;

  expect(expects("leases")).toBe(true);
  expect(expects("insurance")).toBe(true);
  expect(expects("banking-fees")).toBe(true);
  expect(expects("uncategorized")).toBe(true);
});

test("every category answers the question, so nothing falls through undefined", () => {
  const unanswered = allCategories.filter(
    (category) => typeof category.expectsSupplierInvoice !== "boolean",
  );

  expect(unanswered).toEqual([]);
});

test("the invoice question is independent of exclude-from-reports", () => {
  // A VAT payment belongs in the reports — it is real money leaving the account.
  // It just has no supplier invoice. Conflating the two would corrupt cash flow.
  const vat = allCategories.find(
    (category) => category.slug === "vat-gst-pst-qst-payments",
  );

  expect(vat?.expectsSupplierInvoice).toBe(false);
  expect(vat?.excluded).toBe(false);
});
