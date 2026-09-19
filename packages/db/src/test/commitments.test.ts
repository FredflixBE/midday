/**
 * Seam under test: detecting the commitments in a supplier's history,
 * attaching later payments to them, and a person's corrections (FF-1591).
 *
 * The pure series reading is covered in utils/commitment-series.test.ts; the
 * claims here are about what is written and what is never overwritten.
 *
 * Needs the throwaway Postgres from docker-compose.test.yml; see
 * suppliers.test.ts for how to run it.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Database } from "../client";
import {
  detectCommitments,
  getCommitments,
  planCommitments,
  setTransactionCommitment,
  updateCommitment,
} from "../queries/commitments";
import { createSupplier, mergeSuppliers } from "../queries/suppliers";
import { commitments, transactionCategories, transactions } from "../schema";
import { BANK_USD_CHECKING_ID, seedAll, TEAM_USD_ID } from "./helpers/seed";
import {
  cleanDatabase,
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

const SKIP = !isTestDatabaseAvailable();
const TODAY = "2026-09-19";

let sequence = 0;

describe.skipIf(SKIP)("commitments", () => {
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

  async function supplier(name: string) {
    return createSupplier(db, { teamId: TEAM_USD_ID, name });
  }

  async function payment(
    supplierId: string,
    date: string,
    amount: number,
    overrides: Partial<typeof transactions.$inferInsert> = {},
  ) {
    sequence++;
    const [row] = await db
      .insert(transactions)
      .values({
        date,
        name: `Payment ${sequence}`,
        method: "card_purchase",
        amount,
        currency: "USD",
        teamId: TEAM_USD_ID,
        bankAccountId: BANK_USD_CHECKING_ID,
        internalId: `ff1591-${sequence}-${Math.random()}`,
        status: "posted",
        supplierId,
        supplierLink: "rule",
        ...overrides,
      })
      .returning({ id: transactions.id });
    return row!.id;
  }

  /** Cursor, €17.38 on the 30th, February to July. */
  async function cursorHistory() {
    const cursor = await supplier("Cursor Inc");
    const ids: string[] = [];
    for (const day of [
      "2026-02-28",
      "2026-03-30",
      "2026-04-30",
      "2026-05-30",
      "2026-06-30",
      "2026-07-30",
    ]) {
      ids.push(await payment(cursor.id, day, -17.38));
    }
    return { cursor, ids };
  }

  async function commitmentOf(transactionId: string) {
    const [row] = await db
      .select({
        commitmentId: transactions.commitmentId,
        commitmentLink: transactions.commitmentLink,
      })
      .from(transactions)
      .where(eq(transactions.id, transactionId));
    return row!;
  }

  test("a series in history is proposed, with the payments it was read from", async () => {
    const { cursor, ids } = await cursorHistory();

    const result = await detectCommitments(db, {
      teamId: TEAM_USD_ID,
      today: TODAY,
    });

    expect(result).toEqual({ attached: 0, proposed: 1 });

    const [found, ...rest] = await getCommitments(db, {
      teamId: TEAM_USD_ID,
      today: TODAY,
    });
    expect(rest).toEqual([]);
    expect(found).toMatchObject({
      supplierId: cursor.id,
      supplierName: "Cursor Inc",
      status: "proposed",
      kind: "subscription",
      cadence: "monthly",
      priceKind: "fixed",
      amount: -17.38,
      day: 30,
      nextDate: "2026-08-30",
    });
    expect(found?.payments.map((p) => p.id)).toEqual(ids);
  });

  test("next month's payment joins it, and nothing new is proposed", async () => {
    const { cursor } = await cursorHistory();
    await detectCommitments(db, { teamId: TEAM_USD_ID, today: TODAY });

    const august = await payment(cursor.id, "2026-08-30", -17.38);
    const result = await detectCommitments(db, {
      teamId: TEAM_USD_ID,
      supplierIds: [cursor.id],
      today: TODAY,
    });

    expect(result).toEqual({ attached: 1, proposed: 0 });
    const [found] = await getCommitments(db, {
      teamId: TEAM_USD_ID,
      today: TODAY,
    });
    expect(await commitmentOf(august)).toEqual({
      commitmentId: found!.id,
      commitmentLink: "detected",
    });
    expect(found?.nextDate).toBe("2026-09-30");
  });

  test("a rejected series keeps its payments, so it is not proposed again", async () => {
    const { cursor } = await cursorHistory();
    await detectCommitments(db, { teamId: TEAM_USD_ID, today: TODAY });
    const [proposed] = await getCommitments(db, {
      teamId: TEAM_USD_ID,
      today: TODAY,
    });
    await updateCommitment(db, {
      teamId: TEAM_USD_ID,
      id: proposed!.id,
      status: "rejected",
    });

    await payment(cursor.id, "2026-08-30", -17.38);
    const result = await detectCommitments(db, {
      teamId: TEAM_USD_ID,
      today: TODAY,
    });

    expect(result.proposed).toBe(0);
    const all = await getCommitments(db, { teamId: TEAM_USD_ID, today: TODAY });
    expect(all.map((c) => [c.status, c.payments.length, c.nextDate])).toEqual([
      ["rejected", 7, null],
    ]);
  });

  test("the card settlement is not a supplier's commitment", async () => {
    // KBC Bank: the leasing contract on the 3rd, and one month's card
    // settlement the books have not marked internal yet.
    await db
      .insert(transactionCategories)
      .values({
        teamId: TEAM_USD_ID,
        slug: "credit-card-payment",
        name: "Credit card payment",
      })
      .onConflictDoNothing();
    const kbc = await supplier("KBC Bank NV");
    for (const day of ["2026-05-04", "2026-06-03", "2026-07-03"]) {
      await payment(kbc.id, day, -1155.93, { method: "other" });
    }
    const settlements = [];
    for (const day of ["2026-06-01", "2026-07-01", "2026-08-01"]) {
      settlements.push(
        await payment(kbc.id, day, -471.58, {
          method: "other",
          categorySlug: "credit-card-payment",
        }),
      );
    }

    await detectCommitments(db, { teamId: TEAM_USD_ID, today: "2026-07-20" });

    const all = await getCommitments(db, { teamId: TEAM_USD_ID, today: TODAY });
    expect(all.map((c) => c.amount)).toEqual([-1155.93]);
    for (const id of settlements) {
      expect((await commitmentOf(id)).commitmentId).toBeNull();
    }
  });

  test("a payment a person took out of it stays out", async () => {
    const { ids } = await cursorHistory();
    await detectCommitments(db, { teamId: TEAM_USD_ID, today: TODAY });

    await setTransactionCommitment(db, {
      teamId: TEAM_USD_ID,
      transactionId: ids[2]!,
      commitmentId: null,
    });
    await detectCommitments(db, { teamId: TEAM_USD_ID, today: TODAY });

    expect(await commitmentOf(ids[2]!)).toEqual({
      commitmentId: null,
      commitmentLink: "person",
    });
  });

  test("detection never edits a commitment a person corrected", async () => {
    const { cursor } = await cursorHistory();
    await detectCommitments(db, { teamId: TEAM_USD_ID, today: TODAY });
    const [found] = await getCommitments(db, {
      teamId: TEAM_USD_ID,
      today: TODAY,
    });
    await updateCommitment(db, {
      teamId: TEAM_USD_ID,
      id: found!.id,
      status: "active",
      kind: "direct_debit",
      day: 28,
    });

    await payment(cursor.id, "2026-08-28", -19.99);
    await detectCommitments(db, { teamId: TEAM_USD_ID, today: TODAY });

    const [after] = await getCommitments(db, {
      teamId: TEAM_USD_ID,
      today: TODAY,
    });
    expect(after).toMatchObject({
      status: "active",
      kind: "direct_debit",
      day: 28,
      amount: -17.38,
    });
    expect(after?.payments).toHaveLength(7);
  });

  test("an ended commitment predicts nothing, and ending it dates it", async () => {
    await cursorHistory();
    await detectCommitments(db, { teamId: TEAM_USD_ID, today: TODAY });
    const [found] = await getCommitments(db, {
      teamId: TEAM_USD_ID,
      today: TODAY,
    });

    const ended = await updateCommitment(db, {
      teamId: TEAM_USD_ID,
      id: found!.id,
      status: "ended",
    });

    expect(ended?.endsOn).toBe(new Date().toISOString().slice(0, 10));
    const [after] = await getCommitments(db, {
      teamId: TEAM_USD_ID,
      today: TODAY,
    });
    expect(after?.nextDate).toBeNull();
  });

  test("making an ended commitment active again predicts it again", async () => {
    await cursorHistory();
    await detectCommitments(db, { teamId: TEAM_USD_ID, today: TODAY });
    const [found] = await getCommitments(db, {
      teamId: TEAM_USD_ID,
      today: TODAY,
    });
    await updateCommitment(db, {
      teamId: TEAM_USD_ID,
      id: found!.id,
      status: "ended",
    });

    const active = await updateCommitment(db, {
      teamId: TEAM_USD_ID,
      id: found!.id,
      status: "active",
    });

    expect(active?.endsOn).toBeNull();
    const [after] = await getCommitments(db, {
      teamId: TEAM_USD_ID,
      today: TODAY,
    });
    expect(after?.nextDate).toBe("2026-08-30");
  });

  test("a commitment whose payee went quiet predicts nothing", async () => {
    await cursorHistory();
    await detectCommitments(db, { teamId: TEAM_USD_ID, today: TODAY });

    const [later] = await getCommitments(db, {
      teamId: TEAM_USD_ID,
      today: "2026-12-01",
    });

    expect(later?.nextDate).toBeNull();
  });

  test("two detections at once propose a series once", async () => {
    await cursorHistory();

    await Promise.all([
      detectCommitments(db, { teamId: TEAM_USD_ID, today: TODAY }),
      detectCommitments(db, { teamId: TEAM_USD_ID, today: TODAY }),
    ]);

    expect(await db.select().from(commitments)).toHaveLength(1);
  });

  test("a correction with nothing in it is refused", async () => {
    await cursorHistory();
    await detectCommitments(db, { teamId: TEAM_USD_ID, today: TODAY });
    const [found] = await getCommitments(db, {
      teamId: TEAM_USD_ID,
      today: TODAY,
    });

    await expect(
      updateCommitment(db, { teamId: TEAM_USD_ID, id: found!.id }),
    ).rejects.toThrow("Nothing to change");
  });

  test("a series read partly from the model's guesses says how many", async () => {
    const { ids } = await cursorHistory();
    await db
      .update(transactions)
      .set({ supplierLink: "ai" })
      .where(eq(transactions.id, ids[0]!));

    await detectCommitments(db, { teamId: TEAM_USD_ID, today: TODAY });

    const [found] = await getCommitments(db, {
      teamId: TEAM_USD_ID,
      today: TODAY,
    });
    expect(found?.guessed).toBe(1);
  });

  test("the dry run writes nothing", async () => {
    await cursorHistory();

    const plan = await planCommitments(db, {
      teamId: TEAM_USD_ID,
      today: TODAY,
    });

    expect(plan.propose).toHaveLength(1);
    expect(await db.select().from(commitments)).toHaveLength(0);
  });

  test("merging suppliers keeps the commitments", async () => {
    const { cursor } = await cursorHistory();
    await detectCommitments(db, { teamId: TEAM_USD_ID, today: TODAY });
    const kept = await supplier("Anysphere Inc");

    await mergeSuppliers(db, {
      teamId: TEAM_USD_ID,
      sourceId: cursor.id,
      targetId: kept.id,
    });

    const all = await getCommitments(db, { teamId: TEAM_USD_ID, today: TODAY });
    expect(all.map((c) => [c.supplierId, c.payments.length])).toEqual([
      [kept.id, 6],
    ]);
  });
});
