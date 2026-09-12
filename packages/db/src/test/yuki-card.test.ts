/**
 * Seam under test: what linking a card out of the accountant's books writes,
 * and the two things the sync does to rows it did not create — the status of a
 * charge, and the settlement on the current account (FF-1517).
 *
 * Needs the throwaway Postgres from docker-compose.test.yml:
 *   docker compose -f docker-compose.test.yml up -d
 *   bun run test:e2e:setup
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/midday_test bun test src/test/yuki-card.test.ts
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { Database } from "../client";
import {
  createYukiCardConnection,
  getYukiCardConnections,
  markCardSettlementsAsInternal,
  setTransactionsBooksStatus,
  yukiInstitutionId,
} from "../queries/yuki-card";
import { transactions } from "../schema";
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

const CARD = {
  teamId: TEAM_USD_ID,
  userId: TEST_USER_ID,
  glAccountCode: "434001",
  cardName: "Example Card Holder",
  currency: "EUR",
};

describe.skipIf(SKIP)("linking a card from the books", () => {
  let db: Database;

  beforeEach(async () => {
    db = getTestDatabase();
    await cleanDatabase();
    await seedAll(db);
  });

  afterAll(async () => {
    await closeDatabase();
  });

  test("writes a bank connection and one account for the card", async () => {
    const created = await createYukiCardConnection(db, CARD);

    expect(created).not.toBeNull();

    const [card] = await getYukiCardConnections(db, { teamId: TEAM_USD_ID });

    expect(card).toMatchObject({
      id: created?.connectionId,
      name: "Yuki · Example Card Holder",
      glAccountCode: "434001",
      currency: "EUR",
      status: "connected",
    });
    // Never accessed yet — the first sync is what sets that.
    expect(card?.lastAccessed).toBeNull();
  });

  test("refuses the same card twice rather than making a second connection", async () => {
    await createYukiCardConnection(db, CARD);

    expect(await createYukiCardConnection(db, CARD)).toBeNull();
    expect(
      await getYukiCardConnections(db, { teamId: TEAM_USD_ID }),
    ).toHaveLength(1);
  });

  test("lets a second card be linked alongside the first", async () => {
    await createYukiCardConnection(db, CARD);
    await createYukiCardConnection(db, {
      ...CARD,
      glAccountCode: "434002",
      cardName: "A Second Card",
    });

    const cards = await getYukiCardConnections(db, { teamId: TEAM_USD_ID });

    expect(cards.map((c) => c.glAccountCode).sort()).toEqual([
      "434001",
      "434002",
    ]);
  });

  test("keys the connection on the card, and on no shared institution", async () => {
    // `institutions` is global. A row there would put the accounting
    // integration into every other team's bank search.
    expect(yukiInstitutionId("434001")).toBe("yuki:434001");
  });

  test("shows another team's card to nobody", async () => {
    await createYukiCardConnection(db, CARD);

    expect(
      await getYukiCardConnections(db, {
        teamId: "00000000-0000-0000-0000-000000000002",
      }),
    ).toEqual([]);
  });
});

describe.skipIf(SKIP)("where a charge stands in the books", () => {
  let db: Database;
  let bankAccountId: string;

  beforeEach(async () => {
    db = getTestDatabase();
    await cleanDatabase();
    await seedAll(db);

    const created = await createYukiCardConnection(db, CARD);
    bankAccountId = created?.bankAccountId as string;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  async function importCharge(sourceId: string, amount = -21.4) {
    await db.insert(transactions).values({
      teamId: TEAM_USD_ID,
      bankAccountId,
      internalId: `${TEAM_USD_ID}_${sourceId}`,
      name: "EXAMPLE SHOP",
      date: "2026-08-16",
      amount,
      currency: "EUR",
      method: "card_purchase",
    });
  }

  const statusOf = async (sourceId: string) => {
    const [row] = await db
      .select({
        status: transactions.booksStatus,
        reason: transactions.booksStatusReason,
      })
      .from(transactions)
      .where(eq(transactions.internalId, `${TEAM_USD_ID}_${sourceId}`));

    return row;
  };

  test("writes each status against the charge it belongs to", async () => {
    await importCharge("line-a");
    await importCharge("line-b", -55.84);

    const written = await setTransactionsBooksStatus(db, {
      teamId: TEAM_USD_ID,
      entries: [
        { sourceId: "line-a", status: "invoice_missing" },
        { sourceId: "line-b", status: "in_the_books" },
      ],
    });

    expect(written).toBe(2);
    expect(await statusOf("line-a")).toEqual({
      status: "invoice_missing",
      reason: null,
    });
    expect(await statusOf("line-b")).toEqual({
      status: "in_the_books",
      reason: null,
    });
  });

  test("keeps the reason a charge could not be decided", async () => {
    await importCharge("line-c");

    await setTransactionsBooksStatus(db, {
      teamId: TEAM_USD_ID,
      entries: [
        {
          sourceId: "line-c",
          status: "needs_attention",
          reason: "no_counterpart_line",
        },
      ],
    });

    expect(await statusOf("line-c")).toEqual({
      status: "needs_attention",
      reason: "no_counterpart_line",
    });
  });

  test("moves a charge on once the accountant books its invoice", async () => {
    // The import skips rows it already has, so this is the only thing that
    // keeps a status current — and it has to clear the old reason with it.
    await importCharge("line-d");

    await setTransactionsBooksStatus(db, {
      teamId: TEAM_USD_ID,
      entries: [
        {
          sourceId: "line-d",
          status: "needs_attention",
          reason: "amount_differs",
        },
      ],
    });
    await setTransactionsBooksStatus(db, {
      teamId: TEAM_USD_ID,
      entries: [{ sourceId: "line-d", status: "in_the_books" }],
    });

    expect(await statusOf("line-d")).toEqual({
      status: "in_the_books",
      reason: null,
    });
  });

  test("writes nothing for a charge that is not imported yet", async () => {
    expect(
      await setTransactionsBooksStatus(db, {
        teamId: TEAM_USD_ID,
        entries: [{ sourceId: "never-imported", status: "invoice_missing" }],
      }),
    ).toBe(0);
  });
});

describe.skipIf(SKIP)("the monthly settlement", () => {
  let db: Database;
  let cardBankAccountId: string;

  beforeEach(async () => {
    db = getTestDatabase();
    await cleanDatabase();
    await seedAll(db);

    const created = await createYukiCardConnection(db, CARD);
    cardBankAccountId = created?.bankAccountId as string;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  async function currentAccountPayment(params: {
    id: string;
    amount: number;
    date: string;
  }) {
    await db.insert(transactions).values({
      teamId: TEAM_USD_ID,
      bankAccountId: BANK_USD_CHECKING_ID,
      internalId: `${TEAM_USD_ID}_${params.id}`,
      name: "KBC MASTERCARD BUSINESS ESSENTIAL AFREKENING",
      date: params.date,
      amount: params.amount,
      currency: "EUR",
      method: "payment",
    });
  }

  const isInternal = async (id: string) => {
    const [row] = await db
      .select({ internal: transactions.internal })
      .from(transactions)
      .where(
        and(
          eq(transactions.teamId, TEAM_USD_ID),
          eq(transactions.internalId, `${TEAM_USD_ID}_${id}`),
        ),
      );

    return row?.internal;
  };

  test("marks the payment on the current account as an internal transfer", async () => {
    // Left alone, every charge is counted twice: once as itself, and again
    // inside the lump sum the bank took to pay the card off.
    await currentAccountPayment({
      id: "afrekening-nov",
      amount: -281.93,
      date: "2025-11-03",
    });

    expect(
      await markCardSettlementsAsInternal(db, {
        teamId: TEAM_USD_ID,
        cardBankAccountId,
        settlements: [{ amount: 281.93, date: "2025-11-01" }],
      }),
    ).toEqual({ marked: 1, ambiguous: 0, unmatched: 0 });

    expect(await isInternal("afrekening-nov")).toBe(true);
  });

  test("refuses to guess when two payments could be the one", async () => {
    // Guessing here quietly removes a real cost from the figures.
    await currentAccountPayment({
      id: "one",
      amount: -281.93,
      date: "2025-11-02",
    });
    await currentAccountPayment({
      id: "two",
      amount: -281.93,
      date: "2025-11-03",
    });

    expect(
      await markCardSettlementsAsInternal(db, {
        teamId: TEAM_USD_ID,
        cardBankAccountId,
        settlements: [{ amount: 281.93, date: "2025-11-01" }],
      }),
    ).toEqual({ marked: 0, ambiguous: 1, unmatched: 0 });

    expect(await isInternal("one")).toBe(false);
    expect(await isInternal("two")).toBe(false);
  });

  test("reports a settlement whose payment Midday does not hold", async () => {
    expect(
      await markCardSettlementsAsInternal(db, {
        teamId: TEAM_USD_ID,
        cardBankAccountId,
        settlements: [{ amount: 383.41, date: "2025-12-02" }],
      }),
    ).toEqual({ marked: 0, ambiguous: 0, unmatched: 1 });
  });

  test("looks only a few days either side of the date the books gave", async () => {
    await currentAccountPayment({
      id: "too-far",
      amount: -281.93,
      date: "2025-11-20",
    });

    expect(
      await markCardSettlementsAsInternal(db, {
        teamId: TEAM_USD_ID,
        cardBankAccountId,
        settlements: [{ amount: 281.93, date: "2025-11-01" }],
      }),
    ).toMatchObject({ marked: 0, unmatched: 1 });
  });

  test("never marks a charge on the card itself", async () => {
    // The card side of the settlement is not imported at all, but a charge
    // that happens to carry the settlement's amount must not be taken for it.
    await db.insert(transactions).values({
      teamId: TEAM_USD_ID,
      bankAccountId: cardBankAccountId,
      internalId: `${TEAM_USD_ID}_a-charge`,
      name: "EXAMPLE SHOP",
      date: "2025-11-01",
      amount: -281.93,
      currency: "EUR",
      method: "card_purchase",
    });

    expect(
      await markCardSettlementsAsInternal(db, {
        teamId: TEAM_USD_ID,
        cardBankAccountId,
        settlements: [{ amount: 281.93, date: "2025-11-01" }],
      }),
    ).toMatchObject({ marked: 0, unmatched: 1 });

    expect(await isInternal("a-charge")).toBe(false);
  });

  test("leaves a payment it has already marked alone", async () => {
    await currentAccountPayment({
      id: "afrekening",
      amount: -281.93,
      date: "2025-11-03",
    });

    const settlements = [{ amount: 281.93, date: "2025-11-01" }];
    const params = { teamId: TEAM_USD_ID, cardBankAccountId, settlements };

    expect(await markCardSettlementsAsInternal(db, params)).toMatchObject({
      marked: 1,
    });
    // The second run finds nothing to mark, because it only considers
    // transactions that are not internal yet. That is a no-op, not a problem.
    expect(await markCardSettlementsAsInternal(db, params)).toMatchObject({
      marked: 0,
      unmatched: 1,
    });
    expect(await isInternal("afrekening")).toBe(true);
  });
});
