/**
 * Seam under test: which transactions a categoriser run is allowed to see again,
 * and what the team has already decided about a counterparty.
 *
 * Both exist for the same reason. €52,288 of bank payments were written to
 * `uncategorized` and marked finished, which made them permanently invisible to
 * every later run — so fixing the categoriser fixed nothing that had already
 * been given up on. And the same supplier kept getting different answers,
 * because nothing looked at what it had been given before. FF-1554.
 *
 * Needs the throwaway Postgres from docker-compose.test.yml:
 *   docker compose -f docker-compose.test.yml up -d
 *   bun run test:e2e:setup
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/midday_test bun test src/test/transaction-enrichment.test.ts
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Database } from "../client";
import {
  getCategoriesByCounterparty,
  getTransactionsForEnrichment,
} from "../queries/transaction-enrichment";
import { transactionCategories, transactions } from "../schema";
import { BANK_USD_CHECKING_ID, seedAll, TEAM_USD_ID } from "./helpers/seed";
import {
  cleanDatabase,
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

const SKIP = !isTestDatabaseAvailable();

const T = {
  never: "d1000000-0000-0000-0000-0000000000a1",
  failed: "d1000000-0000-0000-0000-0000000000a2",
  gaveUp: "d1000000-0000-0000-0000-0000000000a3",
  classified: "d1000000-0000-0000-0000-0000000000a4",
  second: "d1000000-0000-0000-0000-0000000000a5",
  third: "d1000000-0000-0000-0000-0000000000a6",
};

describe.skipIf(SKIP)("transaction enrichment", () => {
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

  async function makeTransaction(overrides: {
    id: string;
    name?: string;
    counterpartyName?: string | null;
    merchantName?: string | null;
    categorySlug?: string | null;
    enrichmentCompleted?: boolean;
    enrichmentFailedAt?: string | null;
    date?: string;
  }) {
    await db.insert(transactions).values({
      id: overrides.id,
      date: overrides.date ?? "2026-03-01",
      name: overrides.name ?? "Payment",
      method: "other",
      amount: -100,
      currency: "USD",
      teamId: TEAM_USD_ID,
      bankAccountId: BANK_USD_CHECKING_ID,
      internalId: `ff1554-${overrides.id}`,
      status: "posted",
      counterpartyName: overrides.counterpartyName ?? null,
      merchantName: overrides.merchantName ?? null,
      categorySlug: overrides.categorySlug ?? null,
      enrichmentCompleted: overrides.enrichmentCompleted ?? false,
      enrichmentFailedAt: overrides.enrichmentFailedAt ?? null,
    });
  }

  /** A category the seed does not already hold. */
  async function makeCategory(slug: string) {
    await db
      .insert(transactionCategories)
      .values({ teamId: TEAM_USD_ID, slug, name: slug, system: true })
      .onConflictDoNothing();
  }

  describe("which transactions a run may look at", () => {
    test("one nothing has ever enriched", async () => {
      await makeTransaction({ id: T.never });

      const eligible = await getTransactionsForEnrichment(db, {
        teamId: TEAM_USD_ID,
        transactionIds: [T.never],
      });

      expect(eligible.map((row) => row.id)).toEqual([T.never]);
    });

    test("one whose last attempt failed, so a replay reaches it", async () => {
      await makeTransaction({
        id: T.failed,
        enrichmentCompleted: true,
        enrichmentFailedAt: "2026-03-01T00:00:00Z",
      });

      const eligible = await getTransactionsForEnrichment(db, {
        teamId: TEAM_USD_ID,
        transactionIds: [T.failed],
      });

      expect(eligible.map((row) => row.id)).toEqual([T.failed]);
    });

    test("one a previous run gave up on and parked in uncategorized", async () => {
      // This is the €52,288. The run finished, wrote `uncategorized`, and every
      // later run then skipped the row on both counts.
      await makeCategory("uncategorized");
      await makeTransaction({
        id: T.gaveUp,
        categorySlug: "uncategorized",
        enrichmentCompleted: true,
      });

      const eligible = await getTransactionsForEnrichment(db, {
        teamId: TEAM_USD_ID,
        transactionIds: [T.gaveUp],
      });

      expect(eligible.map((row) => row.id)).toEqual([T.gaveUp]);
    });

    test("and not one that is actually classified", async () => {
      await makeTransaction({
        id: T.classified,
        categorySlug: "office-supplies",
        enrichmentCompleted: true,
      });

      const eligible = await getTransactionsForEnrichment(db, {
        teamId: TEAM_USD_ID,
        transactionIds: [T.classified],
      });

      expect(eligible).toEqual([]);
    });

    test("the bank's own classification comes along for the ride", async () => {
      await db.insert(transactions).values({
        id: T.never,
        date: "2026-03-01",
        name: "Batch order",
        method: "other",
        amount: -1800,
        currency: "USD",
        teamId: TEAM_USD_ID,
        bankAccountId: BANK_USD_CHECKING_ID,
        internalId: `ff1554-${T.never}`,
        status: "posted",
        bankTransactionCode: "ICDT",
        bankTransactionSubCode: "SALA",
      });

      const [row] = await getTransactionsForEnrichment(db, {
        teamId: TEAM_USD_ID,
        transactionIds: [T.never],
      });

      expect(row?.bankTransactionSubCode).toBe("SALA");
    });
  });

  describe("what the team already decided about a counterparty", () => {
    test("a name that has been classified answers for the next payment", async () => {
      await makeTransaction({
        id: T.classified,
        counterpartyName: "SD Worx",
        categorySlug: "office-supplies",
      });

      const answers = await getCategoriesByCounterparty(db, {
        teamId: TEAM_USD_ID,
        names: ["sd worx"],
      });

      expect(answers.get("sd worx")).toBe("office-supplies");
    });

    test("matching ignores casing and surrounding space", async () => {
      await makeTransaction({
        id: T.classified,
        counterpartyName: "  SD Worx  ",
        categorySlug: "office-supplies",
      });

      const answers = await getCategoriesByCounterparty(db, {
        teamId: TEAM_USD_ID,
        names: ["SD WORX"],
      });

      expect(answers.get("sd worx")).toBe("office-supplies");
    });

    test("the category used most often wins a disagreement", async () => {
      // The live symptom: one payroll agency across two categories. Whichever it
      // mostly is, is what the next payment should get.
      await makeCategory("contractors");
      await makeTransaction({
        id: T.classified,
        counterpartyName: "SD Worx",
        categorySlug: "office-supplies",
      });
      await makeTransaction({
        id: T.second,
        counterpartyName: "SD Worx",
        categorySlug: "office-supplies",
      });
      await makeTransaction({
        id: T.third,
        counterpartyName: "SD Worx",
        categorySlug: "contractors",
        date: "2026-06-01",
      });

      const answers = await getCategoriesByCounterparty(db, {
        teamId: TEAM_USD_ID,
        names: ["SD Worx"],
      });

      expect(answers.get("sd worx")).toBe("office-supplies");
    });

    test("uncategorized is not something the team decided", async () => {
      await makeCategory("uncategorized");
      await makeTransaction({
        id: T.gaveUp,
        counterpartyName: "SD Worx",
        categorySlug: "uncategorized",
      });

      const answers = await getCategoriesByCounterparty(db, {
        teamId: TEAM_USD_ID,
        names: ["SD Worx"],
      });

      expect(answers.size).toBe(0);
    });

    test("the merchant name answers when the bank named nobody", async () => {
      await makeTransaction({
        id: T.classified,
        counterpartyName: null,
        merchantName: "Adobe Inc",
        categorySlug: "software",
      });

      const answers = await getCategoriesByCounterparty(db, {
        teamId: TEAM_USD_ID,
        names: ["Adobe Inc"],
      });

      expect(answers.get("adobe inc")).toBe("software");
    });

    test("another team's answer is not this team's", async () => {
      await makeTransaction({
        id: T.classified,
        counterpartyName: "SD Worx",
        categorySlug: "office-supplies",
      });

      const answers = await getCategoriesByCounterparty(db, {
        teamId: "00000000-0000-0000-0000-000000000002",
        names: ["SD Worx"],
      });

      expect(answers.size).toBe(0);
    });

    test("asking about nobody asks the database nothing", async () => {
      const answers = await getCategoriesByCounterparty(db, {
        teamId: TEAM_USD_ID,
        names: ["", "   "],
      });

      expect(answers.size).toBe(0);
    });
  });
});
