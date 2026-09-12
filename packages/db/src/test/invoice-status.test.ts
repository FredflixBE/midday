/**
 * Seam under test: the two answers a transaction carries about its invoice, and
 * the list of the ones that still need a person (FF-1499).
 *
 * Midday's own answer and the accountant's answer are independent, and the
 * point of these tests is the cells where they disagree — a payment the books
 * have settled while Midday holds no document is *not* work, and a payment
 * Midday has a document for while the books do not is.
 *
 * Needs the throwaway Postgres from docker-compose.test.yml:
 *   docker compose -f docker-compose.test.yml up -d
 *   bun run test:e2e:setup
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/midday_test bun test src/test/invoice-status.test.ts
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Database } from "../client";
import { countMissingInvoices } from "../queries/invoice-status";
import { getTransactions } from "../queries/transactions";
import {
  inbox,
  transactionAttachments,
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
    booksStatus: overrides.booksStatus ?? null,
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
      await suggestMatch(db, T.suggested, "d0000000-0000-0000-0000-0000000000a1");

      expect((await statusOf(db, T.suggested))?.invoiceStatus).toBe(
        "invoice_pending",
      );
    });

    test("an attachment outranks a suggestion still hanging around", async () => {
      await makeTransaction(db, { id: T.attached, name: "Both" });
      await attachDocument(db, T.attached);
      await suggestMatch(db, T.attached, "d0000000-0000-0000-0000-0000000000a2");

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

  describe("the list of what still needs a person", () => {
    test("counts a payment with no invoice anywhere", async () => {
      await makeTransaction(db, { id: T.nothing, name: "Nothing" });

      expect(await countMissingInvoices(db, { teamId: TEAM_USD_ID })).toEqual({
        missing: 1,
        toConfirm: 0,
      });
    });

    test("counts a suggestion separately, because it is one click rather than a hunt", async () => {
      await makeTransaction(db, { id: T.suggested, name: "Suggested" });
      await suggestMatch(db, T.suggested, "d0000000-0000-0000-0000-0000000000a3");

      expect(await countMissingInvoices(db, { teamId: TEAM_USD_ID })).toEqual({
        missing: 0,
        toConfirm: 1,
      });
    });

    test("leaves out what the books have settled, even with no document in Midday", async () => {
      // The cell that proves these are two axes rather than one ladder: the
      // accountant has it, Midday cannot show it, and there is nothing to do.
      await makeTransaction(db, {
        id: T.settled,
        name: "Settled elsewhere",
        booksStatus: "in_the_books",
      });

      expect(await countMissingInvoices(db, { teamId: TEAM_USD_ID })).toEqual({
        missing: 0,
        toConfirm: 0,
      });
    });

    test("still counts a suggestion the books have settled, because confirming it is Midday's own completeness", async () => {
      await makeTransaction(db, {
        id: T.suggested,
        name: "Settled, unconfirmed",
        booksStatus: "in_the_books",
      });
      await suggestMatch(db, T.suggested, "d0000000-0000-0000-0000-0000000000a4");

      expect(await countMissingInvoices(db, { teamId: TEAM_USD_ID })).toEqual({
        missing: 0,
        toConfirm: 1,
      });
    });

    test("leaves out everything a person has already answered for", async () => {
      await makeTransaction(db, { id: T.attached, name: "Attached" });
      await attachDocument(db, T.attached);
      await makeTransaction(db, {
        id: T.completed,
        name: "Bank fee",
        status: "completed",
      });
      await makeTransaction(db, {
        id: T.excluded,
        name: "Excluded",
        status: "excluded",
      });

      expect(await countMissingInvoices(db, { teamId: TEAM_USD_ID })).toEqual({
        missing: 0,
        toConfirm: 0,
      });
    });

    test("leaves out money coming in, and internal transfers", async () => {
      await makeTransaction(db, {
        id: T.nothing,
        name: "Income",
        amount: 500,
      });
      await makeTransaction(db, {
        id: T.attached,
        name: "Own transfer",
        internal: true,
      });

      expect(await countMissingInvoices(db, { teamId: TEAM_USD_ID })).toEqual({
        missing: 0,
        toConfirm: 0,
      });
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
      await suggestMatch(db, T.suggested, "d0000000-0000-0000-0000-0000000000a5");
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
});
