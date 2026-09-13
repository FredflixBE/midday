/**
 * Seam under test: what the categoriser is allowed to say, what it is asked
 * once per counterparty rather than once per payment, and what it may overwrite.
 *
 * €52,288 of bank payments sat in `uncategorized` on the live books. The cause
 * was not an uncertain model: there was no tax category in the list it was
 * allowed to choose from, so `Btw Ontvangsten Brussel` had nowhere to go. These
 * tests hold the vocabulary and the two rules that let a second run fix a row
 * the first run gave up on. FF-1554.
 */
import { expect, test } from "bun:test";
import type { TransactionForEnrichment } from "@midday/db/queries";
import {
  categoryFromBankTransactionCode,
  counterpartyNames,
  generateEnrichmentPrompt,
  groupForEnrichment,
  knownCategories,
  prepareTransactionData,
  prepareUpdateData,
} from "./enrichment-helpers";
import {
  type EnrichmentResult,
  transactionCategories,
} from "./enrichment-schema";

function transaction(
  overrides: Partial<TransactionForEnrichment> = {},
): TransactionForEnrichment {
  return {
    id: "tx-1",
    name: "BTW ONTVANGSTEN BRUSSEL",
    counterpartyName: "Btw Ontvangsten Brussel",
    merchantName: null,
    description: null,
    amount: -4742,
    currency: "EUR",
    categorySlug: null,
    bankTransactionCode: null,
    bankTransactionSubCode: null,
    ...overrides,
  };
}

function answer(overrides: Partial<EnrichmentResult> = {}): EnrichmentResult {
  return {
    merchant: null,
    category: null,
    categoryConfidence: 0,
    merchantConfidence: 0,
    ...overrides,
  };
}

test("the categoriser can say the things the books actually contain", () => {
  // Every one of these is a category the live books use and the allowed list
  // did not have, which is why the payments stayed uncategorized.
  const allowed: readonly string[] = transactionCategories;

  for (const slug of [
    "vat-gst-pst-qst-payments",
    "income-tax-payments",
    "payroll-tax-remittances",
    "government-fees",
    "owner-draws",
    "salary",
    "loan-principal-repayment",
  ]) {
    expect(allowed).toContain(slug);
  }
});

test("uncategorized is not treated as an answer, so a later run can replace it", () => {
  const updateData = prepareUpdateData(
    transaction({ categorySlug: "uncategorized" }),
    answer({ category: "vat-gst-pst-qst-payments", categoryConfidence: 0.95 }),
  );

  expect(updateData.categorySlug).toBe("vat-gst-pst-qst-payments");
});

test("a real category is left alone, because somebody may have chosen it", () => {
  const updateData = prepareUpdateData(
    transaction({ categorySlug: "insurance" }),
    answer({ category: "banking-fees", categoryConfidence: 0.99 }),
  );

  expect(updateData.categorySlug).toBeUndefined();
});

test("an unanswerable row is still parked in uncategorized, not left blank", () => {
  // Blank would mean "never asked", and the row would be offered again forever.
  const updateData = prepareUpdateData(
    transaction(),
    answer({ category: null, categoryConfidence: 0.2 }),
  );

  expect(updateData.categorySlug).toBe("uncategorized");
});

test("a category below the confidence floor is refused", () => {
  const updateData = prepareUpdateData(
    transaction(),
    answer({ category: "software", categoryConfidence: 0.5 }),
  );

  expect(updateData.categorySlug).toBe("uncategorized");
});

test("the bank's own classification is taken over anything a model would guess", () => {
  // ISO 20022. The bank said these outright; there is nothing to infer.
  expect(
    categoryFromBankTransactionCode(
      transaction({ bankTransactionSubCode: "SALA" }),
    ),
  ).toBe("salary");
  expect(
    categoryFromBankTransactionCode(
      transaction({
        bankTransactionCode: "FTDP",
        bankTransactionSubCode: "RPMT",
      }),
    ),
  ).toBe("leases");
});

test("it says nothing about the codes that do not identify a category", () => {
  // A payment to the VAT office and a payment to a supplier are both ICDT/ESCT.
  expect(
    categoryFromBankTransactionCode(
      transaction({
        bankTransactionCode: "ICDT",
        bankTransactionSubCode: "ESCT",
      }),
    ),
  ).toBeNull();
  expect(categoryFromBankTransactionCode(transaction())).toBeNull();
});

test("one counterparty is one question, however many payments it has", () => {
  const groups = groupForEnrichment([
    transaction({ id: "a", counterpartyName: "Cursor" }),
    transaction({ id: "b", counterpartyName: "Cursor" }),
    transaction({ id: "c", counterpartyName: "cursor  " }),
    transaction({ id: "d", counterpartyName: "Adobe" }),
  ]);

  expect(groups).toHaveLength(2);
  expect(groups[0]?.transactions.map((tx) => tx.id)).toEqual(["a", "b", "c"]);
  expect(groups[1]?.transactions.map((tx) => tx.id)).toEqual(["d"]);
});

test("a payment with no counterparty is its own question", () => {
  // 26 of 125 rows on the live books have no counterparty at all. Grouping them
  // together would apply one supplier's answer to all of them.
  const groups = groupForEnrichment([
    transaction({ id: "a", counterpartyName: null, name: "One" }),
    transaction({ id: "b", counterpartyName: null, name: "Two" }),
  ]);

  expect(groups).toHaveLength(2);
});

test("the merchant name stands in when the bank named nobody", () => {
  const groups = groupForEnrichment([
    transaction({ id: "a", counterpartyName: null, merchantName: "Adobe Inc" }),
    transaction({ id: "b", counterpartyName: null, merchantName: "Adobe Inc" }),
  ]);

  expect(groups).toHaveLength(1);
});

test("the prompt describes one row per group, in the same order", () => {
  const groups = groupForEnrichment([
    transaction({ id: "a", counterpartyName: "Cursor" }),
    transaction({ id: "b", counterpartyName: "Cursor" }),
    transaction({ id: "d", counterpartyName: "Adobe" }),
  ]);

  const data = prepareTransactionData(groups.map((group) => group.asked));

  expect(data).toHaveLength(2);
  expect(data[0]?.description).toContain("Cursor");
  expect(data[1]?.description).toContain("Adobe");
});

test("the bank's answer beats the model's, and needs no confidence", () => {
  const updateData = prepareUpdateData(
    transaction(),
    answer({ category: "contractors", categoryConfidence: 0.99 }),
    "salary",
  );

  expect(updateData.categorySlug).toBe("salary");
});

test("a known category that is not in the allowed list is refused", () => {
  // A slug can reach here from a team's own category, which the categoriser has
  // no vocabulary for. Better to ask than to write something unvalidated.
  const updateData = prepareUpdateData(
    transaction(),
    answer({ category: "software", categoryConfidence: 0.95 }),
    "a-category-somebody-invented",
  );

  expect(updateData.categorySlug).toBe("software");
});

test("a category already chosen is never overwritten, known or not", () => {
  const updateData = prepareUpdateData(
    transaction({ categorySlug: "insurance" }),
    answer(),
    "salary",
  );

  expect(updateData.categorySlug).toBeUndefined();
});

test("what this team already decided for a counterparty is reused", () => {
  const known = knownCategories(
    [
      transaction({ id: "a", counterpartyName: "SD Worx" }),
      transaction({ id: "b", counterpartyName: "sd worx " }),
      transaction({ id: "c", counterpartyName: "Somebody New" }),
    ],
    new Map([["sd worx", "employer-taxes"]]),
  );

  expect(known.get("a")).toBe("employer-taxes");
  expect(known.get("b")).toBe("employer-taxes");
  expect(known.has("c")).toBe(false);
});

test("the bank outranks the memory, because it is not a guess either way", () => {
  const known = knownCategories(
    [
      transaction({
        id: "a",
        counterpartyName: "SD Worx",
        bankTransactionSubCode: "SALA",
      }),
    ],
    new Map([["sd worx", "contractors"]]),
  );

  expect(known.get("a")).toBe("salary");
});

test("nothing is remembered for a row somebody already classified", () => {
  const known = knownCategories(
    [
      transaction({
        id: "a",
        counterpartyName: "SD Worx",
        categorySlug: "insurance",
      }),
    ],
    new Map([["sd worx", "employer-taxes"]]),
  );

  expect(known.has("a")).toBe(false);
});

test("the names a batch asks about are keys, and skip the rows that name nobody", () => {
  expect(
    counterpartyNames([
      transaction({ id: "a", counterpartyName: "Cursor" }),
      transaction({
        id: "b",
        counterpartyName: null,
        merchantName: "Adobe Inc",
      }),
      transaction({ id: "c", counterpartyName: null, merchantName: null }),
      transaction({ id: "d", counterpartyName: "   " }),
    ]),
  ).toEqual(["cursor", "adobe inc"]);
});

test("a batch of uncategorized rows is still asked about categories", () => {
  // The bug this catches shipped once already: the categorisation half of the
  // prompt was gated on a null slug, and every row in the backlog carries
  // `uncategorized`. The new vocabulary was invisible to exactly the payments it
  // was written for.
  const prompt = generateEnrichmentPrompt(
    prepareTransactionData([transaction({ categorySlug: "uncategorized" })]),
    [transaction({ categorySlug: "uncategorized" })],
  );

  expect(prompt).toContain("CATEGORIZATION RULES");
  expect(prompt).toContain("vat-gst-pst-qst-payments");
  expect(prompt).toContain("Btw Ontvangsten");
  expect(prompt).toContain("2. Category");
});

test("a batch that is fully classified is not asked about categories", () => {
  const prompt = generateEnrichmentPrompt(
    prepareTransactionData([transaction({ categorySlug: "insurance" })]),
    [transaction({ categorySlug: "insurance" })],
  );

  expect(prompt).not.toContain("CATEGORIZATION RULES");
});

test("the counterparty reaches the model, whatever the ticket assumed", () => {
  const prompt = generateEnrichmentPrompt(
    prepareTransactionData([transaction()]),
    [transaction()],
  );

  expect(prompt).toContain("Counterparty: Btw Ontvangsten Brussel");
});

test("FTDP only identifies a lease with RPMT beside it", () => {
  expect(
    categoryFromBankTransactionCode(
      transaction({
        bankTransactionCode: "FTDP",
        bankTransactionSubCode: null,
      }),
    ),
  ).toBeNull();
});
