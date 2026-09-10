/**
 * Seam under test: markInboxAttachmentFailed against a real Postgres, because
 * what it does to `meta` is a JSON merge in SQL that no fake driver can check.
 *
 * Needs the throwaway Postgres from docker-compose.test.yml:
 *   docker compose -f docker-compose.test.yml up -d
 *   bun run test:e2e:setup
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/midday_test bun test src/test/inbox-failure.test.ts
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { getInboxFailureReason } from "@midday/utils/inbox-failure";
import { eq } from "drizzle-orm";
import type { Database } from "../client";
import { markInboxAttachmentFailed } from "../queries/inbox";
import { inbox } from "../schema";
import { seedAll, TEAM_EUR_ID } from "./helpers/seed";
import {
  cleanDatabase,
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

const SKIP = !isTestDatabaseAvailable();

const filePath = [TEAM_EUR_ID, "inbox", "IMG_4179.HEIC"];

describe.skipIf(SKIP)("markInboxAttachmentFailed", () => {
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

  async function insertRow(values: {
    status: "processing" | "done";
    meta?: Record<string, unknown>;
  }) {
    await db.insert(inbox).values({
      teamId: TEAM_EUR_ID,
      filePath,
      fileName: "IMG_4179.HEIC",
      contentType: "image/heic",
      status: values.status,
      meta: values.meta,
    });
  }

  async function readRow() {
    const [row] = await db
      .select({ status: inbox.status, meta: inbox.meta })
      .from(inbox)
      .where(eq(inbox.teamId, TEAM_EUR_ID));
    return row;
  }

  test("records the reason the uploader should see", async () => {
    await insertRow({ status: "processing" });

    await markInboxAttachmentFailed(db, {
      filePath,
      teamId: TEAM_EUR_ID,
      reason: "This photo is 48.8 megapixels, more than the 32 we can convert.",
    });

    const row = await readRow();
    expect(row?.status).toBe("failed");
    expect(getInboxFailureReason(row?.meta)).toBe(
      "This photo is 48.8 megapixels, more than the 32 we can convert.",
    );
  });

  test("keeps what meta already held", async () => {
    await insertRow({ status: "processing", meta: { source: "slack" } });

    await markInboxAttachmentFailed(db, {
      filePath,
      teamId: TEAM_EUR_ID,
      reason: "Too large",
    });

    const row = await readRow();
    expect(row?.meta).toMatchObject({
      source: "slack",
      failureReason: "Too large",
    });
  });

  test("clears a reason from an earlier attempt when this failure has none", async () => {
    // Refused once, retried, then failed for some other reason: the refusal
    // must not be shown as the explanation for the second failure.
    await insertRow({
      status: "processing",
      meta: { source: "slack", failureReason: "Too large" },
    });

    await markInboxAttachmentFailed(db, { filePath, teamId: TEAM_EUR_ID });

    const row = await readRow();
    expect(row?.status).toBe("failed");
    expect(getInboxFailureReason(row?.meta)).toBeNull();
    expect(row?.meta).toMatchObject({ source: "slack" });
  });

  test("leaves a row that has already moved on", async () => {
    await insertRow({ status: "done", meta: { source: "slack" } });

    const updated = await markInboxAttachmentFailed(db, {
      filePath,
      teamId: TEAM_EUR_ID,
      reason: "Too large",
    });

    expect(updated).toEqual([]);
    const row = await readRow();
    expect(row?.status).toBe("done");
    expect(row?.meta).toEqual({ source: "slack" });
  });
});

describe("getInboxFailureReason", () => {
  test("reads a reason, and nothing else", () => {
    expect(getInboxFailureReason({ failureReason: "Too large" })).toBe(
      "Too large",
    );
    expect(getInboxFailureReason({ failureReason: null })).toBeNull();
    expect(getInboxFailureReason({ failureReason: "  " })).toBeNull();
    expect(getInboxFailureReason({ failureReason: 42 })).toBeNull();
    expect(getInboxFailureReason({ source: "slack" })).toBeNull();
    expect(getInboxFailureReason(null)).toBeNull();
    expect(getInboxFailureReason("failureReason")).toBeNull();
  });
});
