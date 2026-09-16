/**
 * Giving a pulled invoice the currency and total it billed (FF-1572).
 *
 * Seams under test: the guarded write that changes a pulled row once, the query
 * a backfill reads, and the match that must not copy a tax amount across
 * currencies once a pulled row can be in dollars.
 *
 * Needs the throwaway Postgres from docker-compose.test.yml:
 *   docker compose -f docker-compose.test.yml up -d
 *   bun run test:e2e:setup
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/midday_test bun test src/test/yuki-billed-amount.test.ts
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Database } from "../client";
import { matchTransaction } from "../queries/inbox";
import {
  getYukiInboxIdsForBilledAmount,
  getYukiInboxRowForBilledAmount,
  markYukiBilledAmountRead,
  setYukiInboxBilledAmount,
} from "../queries/yuki-inbox";
import { inbox, transactionAttachments, transactions } from "../schema";
import { BANK_EUR_ACCOUNT_ID, seedAll, TEAM_EUR_ID } from "./helpers/seed";
import {
  cleanDatabase,
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

const SKIP = !isTestDatabaseAvailable();

const PULLED = "d3000000-0000-0000-0000-0000000000c1";
const MAILED = "d3000000-0000-0000-0000-0000000000c2";
const CHARGE = "d3000000-0000-0000-0000-0000000000c3";

/** What Cursor's $19.95 invoice becomes, per `billedAmountCorrection`. */
const billed = {
  amount: 19.95,
  currency: "USD",
  taxAmount: 0,
  baseAmount: 17.22,
  baseCurrency: "EUR",
};

describe.skipIf(SKIP)("giving a pulled invoice what it billed", () => {
  let db: Database;

  beforeEach(async () => {
    db = await getTestDatabase();
    await cleanDatabase();
    await seedAll(db);
    await db
      .delete(transactionAttachments)
      .where(eq(transactionAttachments.teamId, TEAM_EUR_ID));
    await db.delete(inbox).where(eq(inbox.teamId, TEAM_EUR_ID));
    await db.delete(transactions).where(eq(transactions.id, CHARGE));
  });

  afterAll(async () => {
    await closeDatabase();
  });

  /** A row as the pull creates it: Yuki's booked euro, and its VAT. */
  async function insertPulled(
    overrides: Partial<typeof inbox.$inferInsert> = {},
  ) {
    await db.insert(inbox).values({
      id: PULLED,
      teamId: TEAM_EUR_ID,
      referenceId: "yuki:doc-cursor-0017",
      filePath: [TEAM_EUR_ID, "inbox", "Invoice-0BB37ACA-0017.pdf"],
      fileName: "Invoice-0BB37ACA-0017.pdf",
      contentType: "application/pdf",
      amount: 17.22,
      currency: "EUR",
      taxAmount: 3.62,
      status: "done",
      ...overrides,
    });
  }

  const read = async (id = PULLED) => {
    const [row] = await db
      .select({
        amount: inbox.amount,
        currency: inbox.currency,
        taxAmount: inbox.taxAmount,
        baseAmount: inbox.baseAmount,
        baseCurrency: inbox.baseCurrency,
      })
      .from(inbox)
      .where(eq(inbox.id, id));
    return row;
  };

  test("takes the billed currency and total, keeping the booked euro as base", async () => {
    await insertPulled();

    expect(
      await setYukiInboxBilledAmount(db, {
        teamId: TEAM_EUR_ID,
        inboxId: PULLED,
        bookedCurrency: "EUR",
        update: billed,
      }),
    ).toBe(true);

    expect(await read()).toEqual({
      amount: 19.95,
      currency: "USD",
      taxAmount: 0,
      baseAmount: 17.22,
      baseCurrency: "EUR",
    });
  });

  test("happens once: a second write over a corrected row changes nothing", async () => {
    await insertPulled();

    const write = () =>
      setYukiInboxBilledAmount(db, {
        teamId: TEAM_EUR_ID,
        inboxId: PULLED,
        bookedCurrency: "EUR",
        update: { ...billed, amount: 99 },
      });

    expect(await write()).toBe(true);
    // The row is no longer in the booked currency, so the guard refuses — a
    // converted figure is never converted again.
    expect(await write()).toBe(false);
    expect((await read())?.amount).toBe(99);
  });

  test("leaves a row somebody already changed out of the booked currency", async () => {
    await insertPulled({ currency: "GBP", amount: 15 });

    expect(
      await setYukiInboxBilledAmount(db, {
        teamId: TEAM_EUR_ID,
        inboxId: PULLED,
        bookedCurrency: "EUR",
        update: billed,
      }),
    ).toBe(false);
    expect((await read())?.currency).toBe("GBP");
  });

  test("does not reach another team's row", async () => {
    await insertPulled();

    expect(
      await setYukiInboxBilledAmount(db, {
        teamId: "00000000-0000-0000-0000-0000000000ff",
        inboxId: PULLED,
        bookedCurrency: "EUR",
        update: billed,
      }),
    ).toBe(false);
  });

  test("reads only rows the pull made, never a mailbox row", async () => {
    await insertPulled();
    await db.insert(inbox).values({
      id: MAILED,
      teamId: TEAM_EUR_ID,
      referenceId: "gmail:abc",
      filePath: [TEAM_EUR_ID, "inbox", "mail.pdf"],
      amount: 20,
      currency: "USD",
      status: "done",
    });

    expect(
      await getYukiInboxRowForBilledAmount(db, {
        teamId: TEAM_EUR_ID,
        inboxId: MAILED,
      }),
    ).toBeNull();
    expect(
      (
        await getYukiInboxRowForBilledAmount(db, {
          teamId: TEAM_EUR_ID,
          inboxId: PULLED,
        })
      )?.amount,
    ).toBe(17.22);
  });

  test("a backfill lists pulled rows not yet corrected, and nothing else", async () => {
    await insertPulled();
    await db.insert(inbox).values({
      id: MAILED,
      teamId: TEAM_EUR_ID,
      referenceId: "gmail:abc",
      amount: 20,
      currency: "USD",
      status: "done",
    });

    expect(
      await getYukiInboxIdsForBilledAmount(db, { teamId: TEAM_EUR_ID }),
    ).toEqual([PULLED]);

    await setYukiInboxBilledAmount(db, {
      teamId: TEAM_EUR_ID,
      inboxId: PULLED,
      bookedCurrency: "EUR",
      update: billed,
    });

    // Corrected rows drop out, so a second backfill costs nothing.
    expect(
      await getYukiInboxIdsForBilledAmount(db, { teamId: TEAM_EUR_ID }),
    ).toEqual([]);
  });

  test("a row read and left alone is not offered to the next backfill", async () => {
    // A euro invoice is read, found already right, and changed in nothing — but
    // it cost an extraction, and a second backfill must not buy it again.
    await insertPulled({ meta: { source: "yuki" } });

    await markYukiBilledAmountRead(db, {
      teamId: TEAM_EUR_ID,
      inboxId: PULLED,
      outcome: "same-currency",
    });

    expect(
      await getYukiInboxIdsForBilledAmount(db, { teamId: TEAM_EUR_ID }),
    ).toEqual([]);
    expect(
      (
        await getYukiInboxRowForBilledAmount(db, {
          teamId: TEAM_EUR_ID,
          inboxId: PULLED,
        })
      )?.alreadyRead,
    ).toBe(true);

    // Merged into meta, not replacing what was there.
    const [row] = await db
      .select({ meta: inbox.meta })
      .from(inbox)
      .where(eq(inbox.id, PULLED));
    expect(row?.meta).toEqual({
      source: "yuki",
      billedAmountRead: "same-currency",
    });
  });

  describe("matching a document to its transaction", () => {
    async function insertCharge() {
      await db.insert(transactions).values({
        id: CHARGE,
        date: "2025-11-12",
        name: "CURSOR USAGE OCT NEW YORK NY",
        method: "card_purchase",
        amount: -17.57,
        currency: "EUR",
        teamId: TEAM_EUR_ID,
        bankAccountId: BANK_EUR_ACCOUNT_ID,
        internalId: "ff1572-charge",
        status: "posted",
        taxAmount: 3.05,
      });
    }

    const chargeTax = async () => {
      const [row] = await db
        .select({ taxAmount: transactions.taxAmount })
        .from(transactions)
        .where(eq(transactions.id, CHARGE));
      return row?.taxAmount;
    };

    test("does not copy a dollar tax onto a euro transaction", async () => {
      await insertCharge();
      await insertPulled({ ...billed, taxAmount: 1.5, status: "pending" });

      await matchTransaction(db, {
        id: PULLED,
        transactionId: CHARGE,
        teamId: TEAM_EUR_ID,
      });

      // Still the category's €3.05, not "$1.50" read as euro.
      expect(await chargeTax()).toBe(3.05);
    });

    test("still copies the tax when both are in the same currency", async () => {
      await insertCharge();
      await insertPulled({ taxAmount: 3.62, status: "pending" });

      await matchTransaction(db, {
        id: PULLED,
        transactionId: CHARGE,
        teamId: TEAM_EUR_ID,
      });

      expect(await chargeTax()).toBe(3.62);
    });
  });
});
