/**
 * Seam under test: filling in the identifiers on a transaction Midday already
 * had.
 *
 * The sync skips anything it already holds, which is right — a re-sync must not
 * flatten a category somebody chose. But the bank serves a rolling ~85 days and
 * every transaction in that window comes back carrying its IBAN and its ISO
 * 20022 code, including ones stored long before Midday kept them. They were
 * being dropped at the door, which is why FF-1557 thought these fields could
 * only ever fill forward.
 *
 * Needs the throwaway Postgres from docker-compose.test.yml:
 *   docker compose -f docker-compose.test.yml up -d
 *   bun run test:e2e:setup
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/midday_test bun test src/test/transaction-identifiers.test.ts
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Database } from "../client";
import { fillTransactionIdentifiers } from "../queries/transactions";
import { transactions } from "../schema";
import { BANK_USD_CHECKING_ID, seedAll, TEAM_USD_ID } from "./helpers/seed";
import {
  cleanDatabase,
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

const SKIP = !isTestDatabaseAvailable();

const ID = "d2000000-0000-0000-0000-0000000000a1";
const INTERNAL_ID = "ff1557-fill-1";

describe.skipIf(SKIP)("filling in provider identifiers", () => {
  let db: Database;

  beforeEach(async () => {
    db = await getTestDatabase();
    await cleanDatabase();
    await seedAll(db);
    await db.delete(transactions).where(eq(transactions.teamId, TEAM_USD_ID));
  });

  afterAll(async () => {
    await closeDatabase();
  });

  async function makeTransaction(
    overrides: Partial<typeof transactions.$inferInsert> = {},
  ) {
    await db.insert(transactions).values({
      id: ID,
      date: "2026-03-01",
      name: "Payment",
      method: "other",
      amount: -100,
      currency: "USD",
      teamId: TEAM_USD_ID,
      bankAccountId: BANK_USD_CHECKING_ID,
      internalId: INTERNAL_ID,
      status: "posted",
      ...overrides,
    });
  }

  const identifiers = {
    internalId: INTERNAL_ID,
    counterpartyIban: "BE68539007547034",
    bankTransactionCode: "ICDT",
    bankTransactionSubCode: "SALA",
    entryReference: "2026-03-01-06.39.26.668217",
  };

  const read = async () => {
    const [row] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.id, ID));
    return row;
  };

  test("a transaction stored before the identifiers existed receives them", async () => {
    await makeTransaction();

    const filled = await fillTransactionIdentifiers(db, {
      teamId: TEAM_USD_ID,
      entries: [identifiers],
    });

    const row = await read();
    expect(filled).toBe(1);
    expect(row?.counterpartyIban).toBe("BE68539007547034");
    expect(row?.bankTransactionCode).toBe("ICDT");
    expect(row?.bankTransactionSubCode).toBe("SALA");
    expect(row?.entryReference).toBe("2026-03-01-06.39.26.668217");
  });

  test("a value already there is never replaced", async () => {
    await makeTransaction({
      counterpartyIban: "BE00000000000000",
      bankTransactionCode: "IDDT",
    });

    await fillTransactionIdentifiers(db, {
      teamId: TEAM_USD_ID,
      entries: [identifiers],
    });

    const row = await read();
    expect(row?.counterpartyIban).toBe("BE00000000000000");
    expect(row?.bankTransactionCode).toBe("IDDT");
    // The holes beside them are still filled.
    expect(row?.bankTransactionSubCode).toBe("SALA");
  });

  test("nothing else on the row is touched", async () => {
    // The whole reason the sync skips rows it already has: a re-read must not
    // flatten what a person or the enrichment decided.
    await makeTransaction({
      categorySlug: "office-supplies",
      merchantName: "Somebody Ltd",
      note: "keep me",
      status: "completed",
    });

    await fillTransactionIdentifiers(db, {
      teamId: TEAM_USD_ID,
      entries: [identifiers],
    });

    const row = await read();
    expect(row?.categorySlug).toBe("office-supplies");
    expect(row?.merchantName).toBe("Somebody Ltd");
    expect(row?.note).toBe("keep me");
    expect(row?.status).toBe("completed");
  });

  test("a row that already has all four is left alone", async () => {
    await makeTransaction({
      counterpartyIban: "BE68539007547034",
      bankTransactionCode: "ICDT",
      bankTransactionSubCode: "SALA",
      entryReference: "2026-03-01-06.39.26.668217",
    });

    const filled = await fillTransactionIdentifiers(db, {
      teamId: TEAM_USD_ID,
      entries: [identifiers],
    });

    expect(filled).toBe(0);
  });

  test("another team's transaction is not reachable", async () => {
    await makeTransaction();

    const filled = await fillTransactionIdentifiers(db, {
      teamId: "00000000-0000-0000-0000-000000000002",
      entries: [identifiers],
    });

    expect(filled).toBe(0);
    expect((await read())?.counterpartyIban).toBeNull();
  });

  test("an entry carrying no identifiers at all is not a write", async () => {
    // Every transaction from a source that is not a bank payload looks like
    // this — a Yuki card charge, a CSV import.
    await makeTransaction();

    const filled = await fillTransactionIdentifiers(db, {
      teamId: TEAM_USD_ID,
      entries: [
        {
          internalId: INTERNAL_ID,
          counterpartyIban: null,
          bankTransactionCode: null,
          bankTransactionSubCode: null,
          entryReference: null,
        },
      ],
    });

    expect(filled).toBe(0);
  });
});
