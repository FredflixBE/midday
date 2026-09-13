/**
 * Seam under test: the two answers a transaction carries about its invoice, and
 * the list of the ones that still need a person (FF-1499).
 *
 * Midday's own answer and the accountant's answer are independent, and both are
 * carried to the screen untouched — the accountant's stays null wherever the
 * books have nothing to say, which is not the same as saying the invoice is
 * missing.
 *
 * Needs the throwaway Postgres from docker-compose.test.yml:
 *   docker compose -f docker-compose.test.yml up -d
 *   bun run test:e2e:setup
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/midday_test bun test src/test/invoice-status.test.ts
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Database } from "../client";
import {
  countInboxNeedsHandling,
  countMissingInvoices,
  getMissingInvoices,
} from "../queries/invoice-status";
import { getTransactions } from "../queries/transactions";
import {
  inbox,
  transactionAttachments,
  transactionCategories,
  transactionMatchSuggestions,
  transactions,
} from "../schema";
import {
  BANK_USD_CHECKING_ID,
  seedAll,
  TEAM_USD_ID,
  TEST_USER_ID,
} from "./helpers/seed";
import {
  cleanDatabase,
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

const SKIP = !isTestDatabaseAvailable();

/** Every transaction this file makes is an expense on the same account. */
async function makeTransaction(
  db: Database,
  overrides: {
    id: string;
    name: string;
    status?: "posted" | "completed" | "excluded" | "archived";
    booksStatus?: "invoice_missing" | "in_the_books" | null;
    internal?: boolean;
    amount?: number;
    categorySlug?: string;
    counterpartyName?: string | null;
    merchantName?: string | null;
  },
) {
  await db.insert(transactions).values({
    id: overrides.id,
    date: "2026-03-01",
    name: overrides.name,
    method: "other",
    amount: overrides.amount ?? -100,
    currency: "USD",
    teamId: TEAM_USD_ID,
    bankAccountId: BANK_USD_CHECKING_ID,
    internalId: `ff1499-${overrides.id}`,
    status: overrides.status ?? "posted",
    internal: overrides.internal ?? false,
    categorySlug: overrides.categorySlug ?? null,
    booksStatus: overrides.booksStatus ?? null,
    counterpartyName: overrides.counterpartyName ?? null,
    merchantName: overrides.merchantName ?? null,
  });
}

/** A document in the vault, attached to a transaction. */
async function attachDocument(db: Database, transactionId: string) {
  await db.insert(transactionAttachments).values({
    teamId: TEAM_USD_ID,
    transactionId,
    path: ["team", `${transactionId}.pdf`],
    name: `${transactionId}.pdf`,
    type: "application/pdf",
    size: 1000,
  });
}

/** A match the matcher offered and nobody has answered yet. */
async function suggestMatch(
  db: Database,
  transactionId: string,
  inboxId: string,
) {
  await db.insert(inbox).values({
    id: inboxId,
    teamId: TEAM_USD_ID,
    displayName: "Supplier",
    amount: 100,
    currency: "USD",
    status: "suggested_match",
  });

  await db.insert(transactionMatchSuggestions).values({
    teamId: TEAM_USD_ID,
    transactionId,
    inboxId,
    confidenceScore: 0.9,
    matchType: "high_confidence",
    status: "pending",
    userId: TEST_USER_ID,
  });
}

/**
 * A category, and its answer to the one question FF-1553 added: can a payment
 * in it ever settle a supplier debt?
 */
async function makeCategory(
  db: Database,
  slug: string,
  canHaveSupplierInvoice: boolean,
) {
  // Upsert: the seed already holds some of these, and a test should be able to
  // state the answer it depends on without knowing which.
  await db
    .insert(transactionCategories)
    .values({
      teamId: TEAM_USD_ID,
      slug,
      name: slug,
      system: true,
      excluded: false,
      canHaveSupplierInvoice,
    })
    .onConflictDoUpdate({
      target: [transactionCategories.teamId, transactionCategories.slug],
      set: { canHaveSupplierInvoice },
    });
}

async function statusOf(db: Database, transactionId: string) {
  const { data } = await getTransactions(db, {
    teamId: TEAM_USD_ID,
    pageSize: 200,
  });
  return data.find((row) => row.id === transactionId);
}

describe.skipIf(SKIP)("invoice status", () => {
  let db: Database;

  beforeEach(async () => {
    db = await getTestDatabase();
    await cleanDatabase();
    await seedAll(db);
    // The seed's own transactions would drown the handful this file makes.
    await db.delete(transactions).where(eq(transactions.teamId, TEAM_USD_ID));
  });

  afterAll(async () => {
    await closeDatabase();
  });

  const T = {
    nothing: "c0000000-0000-0000-0000-0000000000a1",
    attached: "c0000000-0000-0000-0000-0000000000a2",
    suggested: "c0000000-0000-0000-0000-0000000000a3",
    completed: "c0000000-0000-0000-0000-0000000000a4",
    settled: "c0000000-0000-0000-0000-0000000000a5",
    excluded: "c0000000-0000-0000-0000-0000000000a6",
  };

  describe("Midday's own answer", () => {
    test("a transaction with nothing attached is missing its invoice", async () => {
      await makeTransaction(db, { id: T.nothing, name: "Nothing" });

      expect((await statusOf(db, T.nothing))?.invoiceStatus).toBe(
        "invoice_missing",
      );
    });

    test("an attached document means the invoice is there", async () => {
      await makeTransaction(db, { id: T.attached, name: "Attached" });
      await attachDocument(db, T.attached);

      expect((await statusOf(db, T.attached))?.invoiceStatus).toBe(
        "invoice_attached",
      );
    });

    test("a pending suggestion is a separate state from missing", async () => {
      await makeTransaction(db, { id: T.suggested, name: "Suggested" });
      await suggestMatch(
        db,
        T.suggested,
        "d0000000-0000-0000-0000-0000000000a1",
      );

      expect((await statusOf(db, T.suggested))?.invoiceStatus).toBe(
        "invoice_pending",
      );
    });

    test("an attachment outranks a suggestion still hanging around", async () => {
      await makeTransaction(db, { id: T.attached, name: "Both" });
      await attachDocument(db, T.attached);
      await suggestMatch(
        db,
        T.attached,
        "d0000000-0000-0000-0000-0000000000a2",
      );

      expect((await statusOf(db, T.attached))?.invoiceStatus).toBe(
        "invoice_attached",
      );
    });

    test("marked done without a document needs no invoice, and is not attached", async () => {
      await makeTransaction(db, {
        id: T.completed,
        name: "Bank fee",
        status: "completed",
      });

      const row = await statusOf(db, T.completed);
      // The bug this replaces: `completed` and "has a document" were one value,
      // so a bank fee read as "Ready to export — Receipt attached."
      expect(row?.invoiceStatus).toBe("no_invoice_needed");
      expect(row?.hasAttachment).toBe(false);
    });
  });

  describe("payments that can never have a supplier invoice", () => {
    test("a VAT payment is not described as missing an invoice", async () => {
      // The bug this replaces: six payments to the tax office, EUR 28,454, all
      // announced as missing invoices that will never exist.
      await makeCategory(db, "vat-gst-pst-qst-payments", false);
      await makeTransaction(db, {
        id: T.nothing,
        name: "Btw Ontvangsten Brussel",
        categorySlug: "vat-gst-pst-qst-payments",
      });

      expect((await statusOf(db, T.nothing))?.invoiceStatus).toBeNull();
    });

    test("a card settlement is not either, which the excluded flag never fixed", async () => {
      await makeCategory(db, "credit-card-payment", false);
      await makeTransaction(db, {
        id: T.settled,
        name: "Card settlement",
        categorySlug: "credit-card-payment",
        amount: -472,
      });

      expect((await statusOf(db, T.settled))?.invoiceStatus).toBeNull();
    });

    test("an insurance payment still is — it has an invoice, and it is missing", async () => {
      await makeCategory(db, "insurance", true);
      await makeTransaction(db, {
        id: T.nothing,
        name: "Kbc Verzekeringen",
        categorySlug: "insurance",
      });

      expect((await statusOf(db, T.nothing))?.invoiceStatus).toBe(
        "invoice_missing",
      );
    });

    test("an uncategorised payment stays work, rather than being dropped", async () => {
      await makeTransaction(db, { id: T.nothing, name: "No category" });

      expect((await statusOf(db, T.nothing))?.invoiceStatus).toBe(
        "invoice_missing",
      );
    });

    test("transfers are still exempt, now because the category says so", async () => {
      // This used to be one hardcoded slug in the SQL. The flag replaces it
      // rather than sitting beside it.
      await makeCategory(db, "transfer", false);
      await makeTransaction(db, {
        id: T.nothing,
        name: "Own account withdrawal",
        categorySlug: "transfer",
      });

      expect((await statusOf(db, T.nothing))?.invoiceStatus).toBeNull();
    });

    test("the filter agrees with the status, so the count is the list", async () => {
      await makeCategory(db, "taxes", false);
      await makeCategory(db, "insurance", true);
      await makeTransaction(db, {
        id: T.nothing,
        name: "Insurance",
        categorySlug: "insurance",
      });
      await makeTransaction(db, {
        id: T.settled,
        name: "Tax bill",
        categorySlug: "taxes",
      });

      const { data } = await getTransactions(db, {
        teamId: TEAM_USD_ID,
        invoiceStatuses: ["invoice_missing"],
      });

      expect(data.map((row) => row.id)).toEqual([T.nothing]);
    });
  });

  describe("the missing invoices, grouped by who was paid", () => {
    test("one supplier is one group, however many payments it has", async () => {
      // 125 rows on the live books collapse to 31 counterparties. That
      // collapsing is the whole reason this page is legible.
      await makeTransaction(db, {
        id: T.nothing,
        name: "Cursor",
        counterpartyName: "Cursor",
      });
      await makeTransaction(db, {
        id: T.attached,
        name: "Cursor",
        counterpartyName: "cursor ",
      });
      await makeTransaction(db, {
        id: T.suggested,
        name: "Adobe",
        counterpartyName: "Adobe",
      });

      const { groups } = await getMissingInvoices(db, { teamId: TEAM_USD_ID });

      expect(groups.map((group) => group.name)).toEqual(["Cursor", "Adobe"]);
      expect(groups[0]?.count).toBe(2);
      expect(groups[1]?.count).toBe(1);
    });

    test("the count is the sum of the groups, so it can be clicked into", async () => {
      await makeTransaction(db, {
        id: T.nothing,
        name: "Cursor",
        counterpartyName: "Cursor",
      });
      await makeTransaction(db, {
        id: T.suggested,
        name: "Adobe",
        counterpartyName: "Adobe",
      });

      const { groups, count } = await getMissingInvoices(db, {
        teamId: TEAM_USD_ID,
      });

      expect(count).toBe(2);
      expect(groups.reduce((sum, group) => sum + group.count, 0)).toBe(count);
      expect(await countMissingInvoices(db, { teamId: TEAM_USD_ID })).toBe(
        count,
      );
    });

    test("a blank counterparty falls through to the merchant name", async () => {
      // `merchant_name` covers 279 of 288 expenses on the live books. A
      // counterparty of "  " must not hide it, or those payments read as naming
      // nobody and land in the wrong group.
      await makeTransaction(db, {
        id: T.nothing,
        name: "Adobe",
        counterpartyName: "   ",
        merchantName: "Adobe Inc",
      });

      const { groups } = await getMissingInvoices(db, { teamId: TEAM_USD_ID });

      expect(groups[0]?.name).toBe("Adobe Inc");
      expect(groups[0]?.key).toBe("adobe inc");
    });

    test("whatever names nobody goes in its own group, at the end", async () => {
      // 26 of the 125 have no counterparty. The rule is that the AI may be
      // wrong as long as a person can see it, so these are visible rather than
      // quietly dropped or scattered.
      await makeTransaction(db, {
        id: T.nothing,
        name: "Unknown payment",
        counterpartyName: null,
      });
      await makeTransaction(db, {
        id: T.suggested,
        name: "Adobe",
        counterpartyName: "Adobe",
      });

      const { groups } = await getMissingInvoices(db, { teamId: TEAM_USD_ID });

      expect(groups.at(-1)?.name).toBeNull();
      expect(groups.at(-1)?.count).toBe(1);
    });

    test("a payment that cannot have an invoice is not here at all", async () => {
      await makeCategory(db, "taxes", false);
      await makeTransaction(db, {
        id: T.nothing,
        name: "Tax bill",
        counterpartyName: "Btw Ontvangsten Brussel",
        categorySlug: "taxes",
      });

      const { groups, count } = await getMissingInvoices(db, {
        teamId: TEAM_USD_ID,
      });

      expect(count).toBe(0);
      expect(groups).toEqual([]);
    });

    test("the list empties as invoices are attached", async () => {
      await makeTransaction(db, {
        id: T.nothing,
        name: "Adobe",
        counterpartyName: "Adobe",
      });
      await makeTransaction(db, {
        id: T.attached,
        name: "Adobe",
        counterpartyName: "Adobe",
      });

      expect(
        (await getMissingInvoices(db, { teamId: TEAM_USD_ID })).count,
      ).toBe(2);

      await attachDocument(db, T.attached);

      const { groups, count } = await getMissingInvoices(db, {
        teamId: TEAM_USD_ID,
      });

      expect(count).toBe(1);
      expect(groups[0]?.count).toBe(1);
    });

    test("marking one as needing no invoice takes it out too", async () => {
      await makeTransaction(db, {
        id: T.nothing,
        name: "Adobe",
        counterpartyName: "Adobe",
        status: "completed",
      });

      expect(
        (await getMissingInvoices(db, { teamId: TEAM_USD_ID })).count,
      ).toBe(0);
    });

    test("the accountant's answer rides along, for the rows that have one", async () => {
      // It earns a marker only where it changes the answer: "your accountant is
      // waiting for this" has consequences, "we cannot tell yet" does not.
      await makeTransaction(db, {
        id: T.nothing,
        name: "Adobe",
        counterpartyName: "Adobe",
        booksStatus: "invoice_missing",
      });
      await makeTransaction(db, {
        id: T.suggested,
        name: "Cursor",
        counterpartyName: "Cursor",
      });

      const { groups } = await getMissingInvoices(db, { teamId: TEAM_USD_ID });

      expect(groups[0]?.transactions[0]?.booksStatus).toBe("invoice_missing");
      expect(groups[1]?.transactions[0]?.booksStatus).toBeNull();
    });

    test("each group totals its own money, per currency, and never across", async () => {
      await makeTransaction(db, {
        id: T.nothing,
        name: "Adobe",
        counterpartyName: "Adobe",
        amount: -100,
      });
      await makeTransaction(db, {
        id: T.attached,
        name: "Adobe",
        counterpartyName: "Adobe",
        amount: -50,
      });

      const { groups } = await getMissingInvoices(db, { teamId: TEAM_USD_ID });

      expect(groups[0]?.totals).toEqual([{ currency: "USD", amount: -150 }]);
    });

    test("a payment with a suggested invoice is on the list, and marked", async () => {
      // It has not got the invoice — it is one click from having it. Leaving it
      // off the page hid the quickest work on another screen.
      await makeTransaction(db, {
        id: T.suggested,
        name: "Cursor",
        counterpartyName: "Cursor",
      });
      await suggestMatch(
        db,
        T.suggested,
        "d0000000-0000-0000-0000-0000000000c1",
      );

      const { groups, count, readyToConfirm } = await getMissingInvoices(db, {
        teamId: TEAM_USD_ID,
      });

      expect(count).toBe(1);
      expect(readyToConfirm).toBe(1);
      expect(groups[0]?.transactions[0]?.hasSuggestion).toBe(true);
    });

    test("the suggested ones come first inside their group", async () => {
      await makeTransaction(db, {
        id: T.nothing,
        name: "Cursor",
        counterpartyName: "Cursor",
      });
      await makeTransaction(db, {
        id: T.suggested,
        name: "Cursor",
        counterpartyName: "Cursor",
      });
      await suggestMatch(
        db,
        T.suggested,
        "d0000000-0000-0000-0000-0000000000c2",
      );

      const { groups } = await getMissingInvoices(db, { teamId: TEAM_USD_ID });

      expect(groups[0]?.transactions.map((row) => row.id)).toEqual([
        T.suggested,
        T.nothing,
      ]);
      expect(groups[0]?.count).toBe(2);
      expect(groups[0]?.readyToConfirm).toBe(1);
    });

    test("both numbers are the sum of the groups, so both can be clicked into", async () => {
      await makeTransaction(db, {
        id: T.nothing,
        name: "Adobe",
        counterpartyName: "Adobe",
      });
      await makeTransaction(db, {
        id: T.suggested,
        name: "Cursor",
        counterpartyName: "Cursor",
      });
      await suggestMatch(
        db,
        T.suggested,
        "d0000000-0000-0000-0000-0000000000c3",
      );

      const { groups, count, readyToConfirm } = await getMissingInvoices(db, {
        teamId: TEAM_USD_ID,
      });

      expect(groups.reduce((sum, group) => sum + group.count, 0)).toBe(count);
      expect(groups.reduce((sum, group) => sum + group.readyToConfirm, 0)).toBe(
        readyToConfirm,
      );
      expect(await countMissingInvoices(db, { teamId: TEAM_USD_ID })).toBe(
        count,
      );
    });

    test("an attached invoice still leaves, suggestion or not", async () => {
      await makeTransaction(db, {
        id: T.attached,
        name: "Cursor",
        counterpartyName: "Cursor",
      });
      await suggestMatch(
        db,
        T.attached,
        "d0000000-0000-0000-0000-0000000000c4",
      );
      await attachDocument(db, T.attached);

      expect(
        (await getMissingInvoices(db, { teamId: TEAM_USD_ID })).count,
      ).toBe(0);
    });

    test("the biggest group comes first, since that is the most errands saved", async () => {
      await makeTransaction(db, {
        id: T.nothing,
        name: "Adobe",
        counterpartyName: "Adobe",
      });
      await makeTransaction(db, {
        id: T.suggested,
        name: "Cursor",
        counterpartyName: "Cursor",
      });
      await makeTransaction(db, {
        id: T.attached,
        name: "Cursor",
        counterpartyName: "Cursor",
      });

      const { groups } = await getMissingInvoices(db, { teamId: TEAM_USD_ID });

      expect(groups.map((group) => group.name)).toEqual(["Cursor", "Adobe"]);
    });
  });

  describe("the accountant's answer, alongside", () => {
    test("it is carried through untouched, and stays null when the books cannot say", async () => {
      await makeTransaction(db, {
        id: T.settled,
        name: "Card charge",
        booksStatus: "in_the_books",
      });
      await makeTransaction(db, { id: T.nothing, name: "Bank payment" });

      expect((await statusOf(db, T.settled))?.booksStatus).toBe("in_the_books");
      expect((await statusOf(db, T.nothing))?.booksStatus).toBeNull();
    });
  });

  describe("filtering the list down to one status", () => {
    test("narrows to exactly the transactions in that state", async () => {
      await makeTransaction(db, { id: T.nothing, name: "Nothing" });
      await makeTransaction(db, { id: T.attached, name: "Attached" });
      await attachDocument(db, T.attached);

      const { data } = await getTransactions(db, {
        teamId: TEAM_USD_ID,
        invoiceStatuses: ["invoice_missing"],
      });

      expect(data.map((row) => row.id)).toEqual([T.nothing]);
    });

    test("accepts more than one at a time", async () => {
      await makeTransaction(db, { id: T.nothing, name: "Nothing" });
      await makeTransaction(db, { id: T.suggested, name: "Suggested" });
      await suggestMatch(
        db,
        T.suggested,
        "d0000000-0000-0000-0000-0000000000a5",
      );
      await makeTransaction(db, { id: T.attached, name: "Attached" });
      await attachDocument(db, T.attached);

      const { data } = await getTransactions(db, {
        teamId: TEAM_USD_ID,
        invoiceStatuses: ["invoice_missing", "invoice_pending"],
      });

      expect(data.map((row) => row.id).sort()).toEqual(
        [T.nothing, T.suggested].sort(),
      );
    });
  });

  describe("the inbox side: documents that still need handling", () => {
    const D = {
      open: "e0000000-0000-0000-0000-0000000000b1",
      fromBooks: "e0000000-0000-0000-0000-0000000000b2",
      primary: "e0000000-0000-0000-0000-0000000000b3",
      twin: "e0000000-0000-0000-0000-0000000000b4",
      notAnInvoice: "e0000000-0000-0000-0000-0000000000b5",
      chargesNothing: "e0000000-0000-0000-0000-0000000000b6",
      broken: "e0000000-0000-0000-0000-0000000000b7",
    };

    async function makeDocument(overrides: {
      id: string;
      status?: (typeof inbox.status.enumValues)[number];
      type?: (typeof inbox.type.enumValues)[number] | null;
      referenceId?: string | null;
      transactionId?: string | null;
      groupedInboxId?: string | null;
    }) {
      await db.insert(inbox).values({
        id: overrides.id,
        teamId: TEAM_USD_ID,
        displayName: "Supplier",
        amount: 100,
        currency: "USD",
        status: overrides.status ?? "pending",
        type: overrides.type ?? "invoice",
        referenceId: overrides.referenceId ?? `ref-${overrides.id}`,
        transactionId: overrides.transactionId ?? null,
        groupedInboxId: overrides.groupedInboxId ?? null,
      });
    }

    const count = () => countInboxNeedsHandling(db, { teamId: TEAM_USD_ID });

    test("an open invoice with nothing done to it is work", async () => {
      await makeDocument({ id: D.open });

      expect(await count()).toBe(1);
    });

    test("one already matched to a transaction is not", async () => {
      await makeTransaction(db, { id: T.attached, name: "Paid" });
      await makeDocument({ id: D.open, transactionId: T.attached });

      expect(await count()).toBe(0);
    });

    test("one that came from the books is not, even with no transaction", async () => {
      // Frederik's catch: an invoice with no transaction is not necessarily
      // unhandled. The accountant has this one and has booked it.
      await makeDocument({ id: D.fromBooks, referenceId: "yuki:abc-123" });

      expect(await count()).toBe(0);
    });

    test("one charging nothing is not, and neither is something that is not an invoice", async () => {
      await makeDocument({ id: D.chargesNothing, status: "no_charge" });
      await makeDocument({
        id: D.notAnInvoice,
        status: "other",
        type: "other",
      });

      expect(await count()).toBe(0);
    });

    test("a document whose twin in the same group came from the books is not work", async () => {
      // The group rule. Read one row at a time this looks like an open invoice;
      // read the group and the accountant already has it.
      await makeDocument({ id: D.primary, status: "suggested_match" });
      await makeDocument({
        id: D.twin,
        status: "done",
        referenceId: "yuki:def-456",
        groupedInboxId: D.primary,
      });

      expect(await count()).toBe(0);
    });

    test("a group counts once, never once per copy", async () => {
      await makeDocument({ id: D.primary });
      await makeDocument({ id: D.twin, groupedInboxId: D.primary });

      expect(await count()).toBe(1);
    });

    test("one that failed to process is work, because it wants a retry", async () => {
      await makeDocument({ id: D.broken, status: "failed", type: null });

      expect(await count()).toBe(1);
    });
  });
});
