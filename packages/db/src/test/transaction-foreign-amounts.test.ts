/**
 * Seam under test: filling in what a foreign-currency charge originally cost, on
 * a transaction Midday already had (FF-1560).
 *
 * Same reason as `transaction-identifiers.test.ts`: the sync skips a row it
 * already holds, so a charge stored before Midday kept the amount and rate never
 * receives them, even though Yuki's card ledger re-serves 400 days of charges
 * and Enable Banking a rolling ~85. This is also the backfill for the 62 rows
 * that carry the conversion as the prose `USD 18.60 at 1.15` in `description`.
 *
 * Needs the throwaway Postgres from docker-compose.test.yml:
 *   docker compose -f docker-compose.test.yml up -d
 *   bun run test:e2e:setup
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/midday_test bun test src/test/transaction-foreign-amounts.test.ts
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Database } from "../client";
import { fillTransactionForeignAmounts } from "../queries/transactions";
import { transactions } from "../schema";
import { BANK_USD_CHECKING_ID, seedAll, TEAM_USD_ID } from "./helpers/seed";
import {
  cleanDatabase,
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

const SKIP = !isTestDatabaseAvailable();

const ID = "d2000000-0000-0000-0000-0000000000b1";
const INTERNAL_ID = "ff1560-fill-1";

describe.skipIf(SKIP)(
  "filling in what a foreign charge originally cost",
  () => {
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
        date: "2026-08-16",
        name: "CURSOR AI POWERED IDE",
        method: "card_purchase",
        amount: -16.1,
        currency: "EUR",
        teamId: TEAM_USD_ID,
        bankAccountId: BANK_USD_CHECKING_ID,
        internalId: INTERNAL_ID,
        status: "posted",
        ...overrides,
      });
    }

    /** The charge as the sync now sends it. */
    const charge = {
      internalId: INTERNAL_ID,
      originalAmount: 18.6,
      originalCurrency: "USD",
      exchangeRate: 1.1553,
    };

    const read = async () => {
      const [row] = await db
        .select({
          originalAmount: transactions.originalAmount,
          originalCurrency: transactions.originalCurrency,
          exchangeRate: transactions.exchangeRate,
          description: transactions.description,
        })
        .from(transactions)
        .where(eq(transactions.id, ID));

      return row;
    };

    test("fills the three columns on a row that has none of them", async () => {
      await makeTransaction();

      expect(
        await fillTransactionForeignAmounts(db, {
          teamId: TEAM_USD_ID,
          entries: [charge],
        }),
      ).toBe(1);

      const row = await read();
      expect(row?.originalAmount).toBe(18.6);
      expect(row?.originalCurrency).toBe("USD");
      expect(row?.exchangeRate).toBe(1.1553);
    });

    test("clears the note out of description, on the 62 rows that hold one", async () => {
      // Exactly what `foreignAmountNote` used to write.
      await makeTransaction({ description: "USD 18.60 at 1.15" });

      await fillTransactionForeignAmounts(db, {
        teamId: TEAM_USD_ID,
        entries: [charge],
      });

      // Cleared, not replaced with Yuki's own description — that string is what
      // the conversion was parsed out of, so it would restate it at greater
      // length. The three columns hold it now.
      const row = await read();
      expect(row?.description).toBeNull();
      expect(row?.originalAmount).toBe(18.6);
    });

    test("leaves a description that is a description", async () => {
      await makeTransaction({
        description: "Annual subscription, per contract",
      });

      await fillTransactionForeignAmounts(db, {
        teamId: TEAM_USD_ID,
        entries: [charge],
      });

      const row = await read();
      expect(row?.description).toBe("Annual subscription, per contract");
      // …while still filling what it came for.
      expect(row?.originalAmount).toBe(18.6);
    });

    test("never overwrites a value already there", async () => {
      await makeTransaction({
        originalAmount: 19.99,
        originalCurrency: "GBP",
        exchangeRate: 0.84,
        description: "Already correct",
      });

      await fillTransactionForeignAmounts(db, {
        teamId: TEAM_USD_ID,
        entries: [charge],
      });

      const row = await read();
      expect(row?.originalAmount).toBe(19.99);
      expect(row?.originalCurrency).toBe("GBP");
      expect(row?.exchangeRate).toBe(0.84);
      expect(row?.description).toBe("Already correct");
    });

    test("reports nothing filled when there is nothing left to do", async () => {
      await makeTransaction();

      expect(
        await fillTransactionForeignAmounts(db, {
          teamId: TEAM_USD_ID,
          entries: [charge],
        }),
      ).toBe(1);

      // The second run is the one a daily schedule does: every row comes back and
      // none of them needs anything.
      expect(
        await fillTransactionForeignAmounts(db, {
          teamId: TEAM_USD_ID,
          entries: [charge],
        }),
      ).toBe(0);
    });

    test("ignores a domestic charge entirely", async () => {
      await makeTransaction({ description: "Ordinary euro purchase" });

      expect(
        await fillTransactionForeignAmounts(db, {
          teamId: TEAM_USD_ID,
          entries: [
            {
              internalId: INTERNAL_ID,
              originalAmount: null,
              originalCurrency: null,
              exchangeRate: null,
            },
          ],
        }),
      ).toBe(0);

      expect((await read())?.originalAmount).toBeNull();
    });

    test("settles once for a source that can never fill every column", async () => {
      await makeTransaction();

      // What GoCardless sends: a currency and a rate, and never an amount. The
      // guard has to stop asking for the column this source cannot supply, or
      // `original_amount is null` stays true forever — every sync re-issuing the
      // update and reporting a row as filled that nothing touched.
      const partial = {
        internalId: INTERNAL_ID,
        originalAmount: null,
        originalCurrency: "USD",
        exchangeRate: 1.1553,
      };

      expect(
        await fillTransactionForeignAmounts(db, {
          teamId: TEAM_USD_ID,
          entries: [partial],
        }),
      ).toBe(1);

      expect(
        await fillTransactionForeignAmounts(db, {
          teamId: TEAM_USD_ID,
          entries: [partial],
        }),
      ).toBe(0);

      const row = await read();
      expect(row?.originalCurrency).toBe("USD");
      expect(row?.originalAmount).toBeNull();
    });

    test("does not reach into another team's transactions", async () => {
      await makeTransaction();

      expect(
        await fillTransactionForeignAmounts(db, {
          teamId: "00000000-0000-0000-0000-0000000000ff",
          entries: [charge],
        }),
      ).toBe(0);

      expect((await read())?.originalAmount).toBeNull();
    });
  },
);
