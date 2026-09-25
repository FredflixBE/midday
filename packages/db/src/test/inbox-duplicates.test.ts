/**
 * Seam under test: resolveInvoiceCopies against a real Postgres (FF-1549).
 *
 * The rule itself is unit-tested in utils/inbox-duplicates.test.ts. What only a
 * database can show: which rows the query finds as copies, that a removed copy
 * leaves the inbox and takes its pending suggestions with it, and that a group
 * led by a removed copy is handed to the survivor.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   bun run test:e2e:setup
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/midday_test bun test src/test/inbox-duplicates.test.ts
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import type { Database } from "../client";
import { resolveInvoiceCopies } from "../queries/inbox-duplicates";
import { inbox, transactionMatchSuggestions, transactions } from "../schema";
import {
  BANK_EUR_ACCOUNT_ID,
  seedAll,
  TEAM_EUR_ID,
  TEAM_USD_ID,
} from "./helpers/seed";
import {
  cleanDatabase,
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

const SKIP = !isTestDatabaseAvailable();

const FREDERIK = "a0000000-0000-0000-0000-000000001549";
const SUPPORT = "a0000000-0000-0000-0000-000000001550";
const THIRD = "a0000000-0000-0000-0000-000000001551";
const RECEIPT = "a0000000-0000-0000-0000-000000001552";
const PAYMENT = "b0000000-0000-0000-0000-000000001549";

describe.skipIf(SKIP)("resolveInvoiceCopies", () => {
  let db: Database;

  beforeAll(async () => {
    db = getTestDatabase();
    await cleanDatabase();
    await seedAll(db);
  });

  beforeEach(async () => {
    await db
      .delete(transactionMatchSuggestions)
      .where(eq(transactionMatchSuggestions.teamId, TEAM_EUR_ID));
    await db.delete(inbox).where(eq(inbox.teamId, TEAM_EUR_ID));
    await db.delete(inbox).where(eq(inbox.teamId, TEAM_USD_ID));
    await db.delete(transactions).where(eq(transactions.id, PAYMENT));
    await db.insert(transactions).values({
      id: PAYMENT,
      date: "2026-08-31",
      name: "GOOGLE CLOUD",
      method: "card_purchase",
      amount: -39,
      currency: "EUR",
      teamId: TEAM_EUR_ID,
      bankAccountId: BANK_EUR_ACCOUNT_ID,
      internalId: "ff1549-payment",
      status: "posted",
    });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  /** One of Google's per-recipient PDFs of invoice 5664449825. */
  async function googleCopy(
    id: string,
    overrides: Partial<typeof inbox.$inferInsert> = {},
  ) {
    await db.insert(inbox).values({
      id,
      teamId: TEAM_EUR_ID,
      filePath: [TEAM_EUR_ID, "inbox", `5664449825_${id.slice(-4)}.pdf`],
      fileName: `5664449825_${id.slice(-4)}.pdf`,
      contentType: "application/pdf",
      referenceId: `sha256-of-${id}`,
      displayName: "Google Cloud EMEA Limited",
      invoiceNumber: "5664449825",
      amount: 39,
      currency: "EUR",
      date: "2026-08-31",
      type: "invoice",
      status: "pending",
      ...overrides,
    });
  }

  async function pendingSuggestion(inboxId: string) {
    await db.insert(transactionMatchSuggestions).values({
      teamId: TEAM_EUR_ID,
      inboxId,
      transactionId: PAYMENT,
      confidenceScore: 0.9,
      matchType: "high_confidence",
      status: "pending",
    });
  }

  async function statusOf(id: string) {
    const [row] = await db
      .select({ status: inbox.status, groupedInboxId: inbox.groupedInboxId })
      .from(inbox)
      .where(eq(inbox.id, id));
    return row;
  }

  test("the same invoice from two mailboxes leaves one copy, and one suggestion", async () => {
    await googleCopy(FREDERIK, { createdAt: "2026-09-12T16:00:00Z" });
    await googleCopy(SUPPORT, { createdAt: "2026-09-12T16:00:03Z" });
    await pendingSuggestion(FREDERIK);
    await pendingSuggestion(SUPPORT);

    const result = await resolveInvoiceCopies(db, {
      inboxId: SUPPORT,
      teamId: TEAM_EUR_ID,
      apply: true,
    });

    expect(result).toEqual({
      keep: FREDERIK,
      removed: [SUPPORT],
      currentRemoved: true,
    });
    expect((await statusOf(SUPPORT))?.status).toBe("deleted");
    expect((await statusOf(FREDERIK))?.status).toBe("pending");
    const suggestions = await db
      .select({ inboxId: transactionMatchSuggestions.inboxId })
      .from(transactionMatchSuggestions)
      .where(eq(transactionMatchSuggestions.teamId, TEAM_EUR_ID));
    expect(suggestions).toEqual([{ inboxId: FREDERIK }]);
  });

  test("asking from the older copy reaches the same decision", async () => {
    await googleCopy(FREDERIK, { createdAt: "2026-09-12T16:00:00Z" });
    await googleCopy(SUPPORT, { createdAt: "2026-09-12T16:00:03Z" });

    const result = await resolveInvoiceCopies(db, {
      inboxId: FREDERIK,
      teamId: TEAM_EUR_ID,
      apply: true,
    });

    expect(result).toEqual({
      keep: FREDERIK,
      removed: [SUPPORT],
      currentRemoved: false,
    });
    expect((await statusOf(SUPPORT))?.status).toBe("deleted");
  });

  test("a dry run says what it would do and changes nothing", async () => {
    await googleCopy(FREDERIK, { createdAt: "2026-09-12T16:00:00Z" });
    await googleCopy(SUPPORT, { createdAt: "2026-09-12T16:00:03Z" });

    const result = await resolveInvoiceCopies(db, {
      inboxId: SUPPORT,
      teamId: TEAM_EUR_ID,
      apply: false,
    });

    expect(result?.removed).toEqual([SUPPORT]);
    expect((await statusOf(SUPPORT))?.status).toBe("pending");
  });

  test("the copy already matched to the payment is the one that stays", async () => {
    await googleCopy(FREDERIK, { createdAt: "2026-09-12T16:00:00Z" });
    await googleCopy(SUPPORT, {
      createdAt: "2026-09-12T16:00:03Z",
      transactionId: PAYMENT,
      status: "done",
    });

    const result = await resolveInvoiceCopies(db, {
      inboxId: FREDERIK,
      teamId: TEAM_EUR_ID,
      apply: true,
    });

    expect(result?.keep).toBe(SUPPORT);
    expect((await statusOf(FREDERIK))?.status).toBe("deleted");
    expect((await statusOf(SUPPORT))?.status).toBe("done");
  });

  test("a copy from the books is never removed", async () => {
    await googleCopy(FREDERIK, { createdAt: "2026-09-12T16:00:00Z" });
    await googleCopy(SUPPORT, {
      createdAt: "2026-09-10T00:00:00Z",
      referenceId: "yuki:4ad0b24e",
      status: "done",
    });

    const result = await resolveInvoiceCopies(db, {
      inboxId: FREDERIK,
      teamId: TEAM_EUR_ID,
      apply: true,
    });

    expect(result).toBeNull();
    expect((await statusOf(SUPPORT))?.status).toBe("done");
    expect((await statusOf(FREDERIK))?.status).toBe("pending");
  });

  test("the receipt grouped under a removed copy moves to the survivor", async () => {
    await googleCopy(FREDERIK, { createdAt: "2026-09-12T16:00:03Z" });
    await googleCopy(SUPPORT, {
      createdAt: "2026-09-12T16:00:00Z",
      groupedInboxId: FREDERIK,
    });
    await googleCopy(RECEIPT, {
      createdAt: "2026-09-12T16:00:05Z",
      type: "expense",
      groupedInboxId: FREDERIK,
    });

    // FREDERIK leads the group, so it survives even though SUPPORT is older.
    const first = await resolveInvoiceCopies(db, {
      inboxId: SUPPORT,
      teamId: TEAM_EUR_ID,
      apply: true,
    });
    expect(first?.keep).toBe(FREDERIK);
    expect((await statusOf(RECEIPT))?.groupedInboxId).toBe(FREDERIK);

    // Now make the leader the one to go: a third, matched copy arrives.
    await googleCopy(THIRD, {
      createdAt: "2026-09-13T00:00:00Z",
      transactionId: PAYMENT,
      status: "done",
    });
    const second = await resolveInvoiceCopies(db, {
      inboxId: THIRD,
      teamId: TEAM_EUR_ID,
      apply: true,
    });
    expect(second).toEqual({
      keep: THIRD,
      removed: [FREDERIK],
      currentRemoved: false,
    });
    expect((await statusOf(RECEIPT))?.groupedInboxId).toBe(THIRD);
    expect((await statusOf(THIRD))?.groupedInboxId).toBeNull();
  });

  test("a different amount, supplier or team is not a copy", async () => {
    await googleCopy(FREDERIK, { createdAt: "2026-09-12T16:00:00Z" });
    await googleCopy(SUPPORT, {
      createdAt: "2026-09-12T16:00:03Z",
      amount: 41.59,
    });
    await googleCopy(THIRD, {
      createdAt: "2026-09-12T16:00:04Z",
      displayName: "Adobe Systems Software Ireland Ltd",
    });
    await googleCopy(RECEIPT, {
      createdAt: "2026-09-12T16:00:05Z",
      teamId: TEAM_USD_ID,
    });

    expect(
      await resolveInvoiceCopies(db, {
        inboxId: FREDERIK,
        teamId: TEAM_EUR_ID,
        apply: true,
      }),
    ).toBeNull();
    for (const id of [FREDERIK, SUPPORT, THIRD, RECEIPT]) {
      expect((await statusOf(id))?.status).toBe("pending");
    }
  });

  test("a document without an invoice number is left alone", async () => {
    await googleCopy(FREDERIK, { invoiceNumber: null });
    await googleCopy(SUPPORT, { invoiceNumber: null });

    expect(
      await resolveInvoiceCopies(db, {
        inboxId: SUPPORT,
        teamId: TEAM_EUR_ID,
        apply: true,
      }),
    ).toBeNull();
  });
});
