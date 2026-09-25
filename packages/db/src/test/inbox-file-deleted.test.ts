/**
 * Seam under test: whether the inbox item behind a stored file has been
 * deleted. process-attachment asks this when the file it was sent for is not
 * in the vault, and before it creates a row for a file nobody holds a row for
 * (FF-1469). Deleting is a status, not a removed row, so only a real Postgres
 * shows what a deleted item leaves behind.
 *
 * Needs the throwaway Postgres from docker-compose.test.yml:
 *   docker compose -f docker-compose.test.yml up -d
 *   bun run test:e2e:setup
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/midday_test bun test src/test/inbox-file-deleted.test.ts
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
import { deleteInbox, inboxFileWasDeleted } from "../queries/inbox";
import { resolveInvoiceCopies } from "../queries/inbox-duplicates";
import { inbox } from "../schema";
import { seedAll, TEAM_EUR_ID } from "./helpers/seed";
import {
  cleanDatabase,
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

const SKIP = !isTestDatabaseAvailable();

const filePath = [TEAM_EUR_ID, "inbox", "receipt_ab12cd.pdf"];
const otherFilePath = [TEAM_EUR_ID, "inbox", "receipt_ef34gh.pdf"];

describe.skipIf(SKIP)("inboxFileWasDeleted", () => {
  let db: Database;

  beforeAll(async () => {
    db = getTestDatabase();
    await cleanDatabase();
    await seedAll(db);
  });

  beforeEach(async () => {
    await db.delete(inbox).where(eq(inbox.teamId, TEAM_EUR_ID));
  });

  afterAll(async () => {
    await closeDatabase();
  });

  async function insertRow(
    path: string[],
    values: Partial<typeof inbox.$inferInsert> = {},
  ) {
    const [row] = await db
      .insert(inbox)
      .values({
        teamId: TEAM_EUR_ID,
        filePath: path,
        fileName: path.at(-1),
        contentType: "application/pdf",
        status: "processing",
        ...values,
      })
      .returning({ id: inbox.id });
    return row!.id;
  }

  const ask = (path = filePath) =>
    inboxFileWasDeleted(db, { filePath: path, teamId: TEAM_EUR_ID });

  test("is true once the user has deleted the item", async () => {
    const id = await insertRow(filePath, { status: "new" });

    await deleteInbox(db, { id, teamId: TEAM_EUR_ID });

    expect(await ask()).toBe(true);
  });

  test("is false while the item is still being processed", async () => {
    await insertRow(filePath);

    expect(await ask()).toBe(false);
  });

  test("is false for a file no row was ever made for", async () => {
    // Email sync triggers the run before any row exists; that run has to go on
    // and create one.
    expect(await ask()).toBe(false);
  });

  test("is false when a live row for the file remains beside a deleted one", async () => {
    const id = await insertRow(filePath);
    await deleteInbox(db, { id, teamId: TEAM_EUR_ID });
    await insertRow(filePath, { status: "failed" });

    expect(await ask()).toBe(false);
  });

  test("is not fooled by another file's deleted item", async () => {
    const id = await insertRow(otherFilePath);
    await deleteInbox(db, { id, teamId: TEAM_EUR_ID });

    expect(await ask()).toBe(false);
  });

  test("is true for the copy removed as a duplicate of the same invoice", async () => {
    // FF-1549: the spare copy of one invoice from a second mailbox is marked
    // deleted by the other copy's run, and a retry of this one must not
    // bring it back.
    const invoice = {
      status: "analyzing" as const,
      invoiceNumber: "INV-1001",
      amount: 120,
      currency: "EUR",
      displayName: "Acme",
      type: "expense" as const,
    };
    await insertRow(otherFilePath, {
      ...invoice,
      createdAt: "2026-09-01T10:00:00Z",
    });
    const spare = await insertRow(filePath, {
      ...invoice,
      createdAt: "2026-09-01T10:05:00Z",
    });

    const copies = await resolveInvoiceCopies(db, {
      inboxId: spare,
      teamId: TEAM_EUR_ID,
      apply: true,
    });
    expect(copies).toMatchObject({ outcome: "resolved", currentRemoved: true });

    expect(await ask(filePath)).toBe(true);
    expect(await ask(otherFilePath)).toBe(false);
  });
});
