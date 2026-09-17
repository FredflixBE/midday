/**
 * Closing an inbox document from the payment it is attached to (FF-1580).
 *
 * Seams under test: the match a payment's "attach from inbox" now goes through,
 * and what removing one file from a payment does to the other documents on it.
 *
 * Needs the throwaway Postgres from docker-compose.test.yml:
 *   docker compose -f docker-compose.test.yml up -d
 *   bun run test:e2e:setup
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/midday_test bun test src/test/inbox-attach-from-payment.test.ts
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { Database } from "../client";
import { matchTransaction } from "../queries/inbox";
import { countInboxNeedsHandling } from "../queries/invoice-status";
import { deleteAttachment } from "../queries/transaction-attachments";
import {
  inbox,
  transactionAttachments,
  transactionMatchSuggestions,
  transactions,
} from "../schema";
import {
  BANK_EUR_ACCOUNT_ID,
  seedAll,
  TEAM_EUR_ID,
  TEST_USER_ID,
} from "./helpers/seed";
import {
  cleanDatabase,
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

const SKIP = !isTestDatabaseAvailable();

const PAYMENT = "d4000000-0000-0000-0000-0000000000a1";
const MAILED = "d4000000-0000-0000-0000-0000000000b1";
const PULLED = "d4000000-0000-0000-0000-0000000000b2";

describe.skipIf(SKIP)("attaching an inbox document from a payment", () => {
  let db: Database;

  beforeEach(async () => {
    db = getTestDatabase();
    await cleanDatabase();
    await seedAll(db);
    await db
      .delete(transactionAttachments)
      .where(eq(transactionAttachments.teamId, TEAM_EUR_ID));
    await db.delete(inbox).where(eq(inbox.teamId, TEAM_EUR_ID));

    await db.insert(transactions).values({
      id: PAYMENT,
      date: "2026-07-31",
      name: "PRISMA DATA",
      method: "card_purchase",
      amount: -8.67,
      currency: "EUR",
      teamId: TEAM_EUR_ID,
      bankAccountId: BANK_EUR_ACCOUNT_ID,
      internalId: "ff1580-payment",
      status: "posted",
    });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  async function insertDocument(
    id: string,
    overrides: Partial<typeof inbox.$inferInsert> = {},
  ) {
    await db.insert(inbox).values({
      id,
      teamId: TEAM_EUR_ID,
      filePath: [TEAM_EUR_ID, "inbox", `${id}.pdf`],
      fileName: `${id}.pdf`,
      contentType: "application/pdf",
      size: 1000,
      displayName: "Prisma Data, Inc.",
      invoiceNumber: "29A0586F-92955",
      amount: 10,
      currency: "USD",
      type: "invoice",
      status: "pending",
      ...overrides,
    });
  }

  const row = async (id: string) => {
    const [found] = await db
      .select({
        status: inbox.status,
        transactionId: inbox.transactionId,
        attachmentId: inbox.attachmentId,
      })
      .from(inbox)
      .where(eq(inbox.id, id));
    return found;
  };

  test("closes the document, so it no longer counts in Needs handling", async () => {
    await insertDocument(MAILED);
    expect(await countInboxNeedsHandling(db, { teamId: TEAM_EUR_ID })).toBe(1);

    await matchTransaction(db, {
      id: MAILED,
      transactionId: PAYMENT,
      teamId: TEAM_EUR_ID,
    });

    expect(await row(MAILED)).toMatchObject({
      status: "done",
      transactionId: PAYMENT,
    });
    expect((await row(MAILED))?.attachmentId).not.toBeNull();
    expect(await countInboxNeedsHandling(db, { teamId: TEAM_EUR_ID })).toBe(0);

    // One file on the payment, not a second copy of it.
    const files = await db
      .select({ id: transactionAttachments.id })
      .from(transactionAttachments)
      .where(eq(transactionAttachments.transactionId, PAYMENT));
    expect(files).toHaveLength(1);
  });

  test("confirms a pending suggestion for the same pair", async () => {
    await insertDocument(MAILED, { status: "suggested_match" });
    await db.insert(transactionMatchSuggestions).values({
      teamId: TEAM_EUR_ID,
      inboxId: MAILED,
      transactionId: PAYMENT,
      confidenceScore: 0.8,
      matchType: "suggested",
      status: "pending",
    });

    await matchTransaction(db, {
      id: MAILED,
      transactionId: PAYMENT,
      teamId: TEAM_EUR_ID,
      userId: TEST_USER_ID,
    });

    const [suggestion] = await db
      .select({
        status: transactionMatchSuggestions.status,
        userId: transactionMatchSuggestions.userId,
      })
      .from(transactionMatchSuggestions)
      .where(
        and(
          eq(transactionMatchSuggestions.inboxId, MAILED),
          eq(transactionMatchSuggestions.transactionId, PAYMENT),
        ),
      );
    expect(suggestion).toEqual({ status: "confirmed", userId: TEST_USER_ID });
  });
});

describe.skipIf(SKIP)("removing one file from a payment", () => {
  let db: Database;

  beforeEach(async () => {
    db = getTestDatabase();
    await cleanDatabase();
    await seedAll(db);
    await db
      .delete(transactionAttachments)
      .where(eq(transactionAttachments.teamId, TEAM_EUR_ID));
    await db.delete(inbox).where(eq(inbox.teamId, TEAM_EUR_ID));
    await db.insert(transactions).values({
      id: PAYMENT,
      date: "2026-07-31",
      name: "PRISMA DATA",
      method: "card_purchase",
      amount: -8.67,
      currency: "EUR",
      teamId: TEAM_EUR_ID,
      bankAccountId: BANK_EUR_ACCOUNT_ID,
      internalId: "ff1580-payment",
      status: "posted",
    });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  test("leaves the other copy of the invoice on the payment", async () => {
    // The live shape of the six rows in FF-1580: a mailed invoice and its Yuki
    // copy, matched as one group, so the payment gets a file for each. Removing
    // the duplicate file must not unlink the copy whose file stays.
    await db.insert(inbox).values([
      {
        id: MAILED,
        teamId: TEAM_EUR_ID,
        filePath: [TEAM_EUR_ID, "inbox", "mailed.pdf"],
        fileName: "mailed.pdf",
        contentType: "application/pdf",
        size: 1000,
        status: "pending",
      },
      {
        id: PULLED,
        teamId: TEAM_EUR_ID,
        filePath: [TEAM_EUR_ID, "inbox", "pulled.pdf"],
        fileName: "pulled.pdf",
        contentType: "application/pdf",
        size: 1000,
        status: "pending",
        groupedInboxId: MAILED,
      },
    ]);

    await matchTransaction(db, {
      id: MAILED,
      transactionId: PAYMENT,
      teamId: TEAM_EUR_ID,
    });

    const pulledBefore = await db
      .select({ attachmentId: inbox.attachmentId })
      .from(inbox)
      .where(eq(inbox.id, PULLED));
    const [mailed] = await db
      .select({ attachmentId: inbox.attachmentId })
      .from(inbox)
      .where(eq(inbox.id, MAILED));

    await deleteAttachment(db, {
      id: mailed!.attachmentId!,
      teamId: TEAM_EUR_ID,
    });

    const [pulled] = await db
      .select({
        status: inbox.status,
        transactionId: inbox.transactionId,
        attachmentId: inbox.attachmentId,
      })
      .from(inbox)
      .where(eq(inbox.id, PULLED));

    expect(pulled).toEqual({
      status: "done",
      transactionId: PAYMENT,
      attachmentId: pulledBefore[0]!.attachmentId,
    });

    // The document whose file was removed is unlinked, as before.
    const [removed] = await db
      .select({ status: inbox.status, transactionId: inbox.transactionId })
      .from(inbox)
      .where(eq(inbox.id, MAILED));
    expect(removed).toEqual({ status: "pending", transactionId: null });
  });
});
