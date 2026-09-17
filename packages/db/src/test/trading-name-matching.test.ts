/**
 * A supplier trading under another name (FF-1565).
 *
 * The card statement said `TEXACO REED BE2840 REET`. The invoice came from
 * **Horbo**, the company that operates the station. Same purchase, same amount
 * to the cent, one day apart, and no word in common. Frederik confirmed the
 * pair by hand; the matcher had offered nothing.
 *
 * The amounts and the dates agree, and both sides are Midday's own rows — one
 * system, one source, one currency — which is the comparison FF-1537 permits.
 * What refused the pair was the name: `scoreMatch` multiplies a confidence by
 * 0.55 whenever the names share nothing, and it did so *after* the floor that
 * an exact amount had just established. 0.78 became 0.429 and fell under the
 * 0.6 a suggestion needs.
 *
 * The opposite failure is what keeps this narrow. Six monthly Cursor charges of
 * €17.38 all have an exact amount and the same currency; what tells November
 * from February is the date, and nothing here may weaken that.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "../client";
import { findMatches } from "../queries/transaction-matching";
import { inbox, transactions } from "../schema";
import { scoreMatch } from "../utils/transaction-matching";
import { BANK_USD_CHECKING_ID, seedAll, TEAM_USD_ID } from "./helpers/seed";
import {
  cleanDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

/** The lowest confidence `findMatches` will ever propose. */
const SUGGESTED_THRESHOLD = 0.6;

describe("a payment and an invoice with no name in common", () => {
  /**
   * Horbo against `TEXACO REED BE2840 REET`: nothing shared but the money and
   * the day.
   */
  const noNameInCommon = {
    nameScore: 0,
    amountScore: 1,
    currencyScore: 1,
    isSameCurrency: true,
    isExactAmount: true,
    dateScore: 0.85,
  };

  test("is proposed when the amount is exact and the day is close", () => {
    const confidence = scoreMatch({ ...noNameInCommon, daysApart: 1 });

    expect(confidence).toBeGreaterThanOrEqual(SUGGESTED_THRESHOLD);
  });

  test("is refused when the same amount is months away", () => {
    // Cursor's November invoice against the February payment: same supplier,
    // same €17.38, 108 days apart. Without a name to go on, an amount that
    // recurs every month identifies nothing.
    const confidence = scoreMatch({ ...noNameInCommon, daysApart: 108 });

    expect(confidence).toBeLessThan(SUGGESTED_THRESHOLD);
  });

  test("is refused when the amounts only nearly agree", () => {
    // €167.00 paid to `Le Quai Son` against a €164.40 invoice from `QS
    // EXPLOITATION`. A person can see it; two numbers that differ cannot say
    // it, and there is no name to make up the difference.
    const confidence = scoreMatch({
      ...noNameInCommon,
      amountScore: 0.9,
      isExactAmount: false,
      daysApart: 1,
    });

    expect(confidence).toBeLessThan(SUGGESTED_THRESHOLD);
  });

  test("is refused when the currencies differ", () => {
    // Two amounts that agree through an exchange rate agree less than two that
    // agree outright, and FF-1537's guarantee is about one currency.
    const confidence = scoreMatch({
      ...noNameInCommon,
      isSameCurrency: false,
      daysApart: 1,
    });

    expect(confidence).toBeLessThan(SUGGESTED_THRESHOLD);
  });

  test("is refused when nothing says how far apart the two are", () => {
    // A caller that cannot say the gap gets the old answer, not the benefit of
    // the doubt.
    const confidence = scoreMatch(noNameInCommon);

    expect(confidence).toBeLessThan(SUGGESTED_THRESHOLD);
  });
});

describe("a pair that does share a name", () => {
  /** A monthly subscription: the supplier is obvious, the month is not. */
  const cursor = {
    nameScore: 0.95,
    amountScore: 1,
    currencyScore: 1,
    isSameCurrency: true,
    isExactAmount: true,
  };

  test("scores exactly as it did before, near or far", () => {
    // Nothing above may loosen the wrong-month case, so it is pinned from both
    // sides: the score with the gap known is the score without it.
    for (const dateScore of [0.99, 0.75]) {
      for (const daysApart of [1, 108]) {
        expect(scoreMatch({ ...cursor, dateScore, daysApart })).toBe(
          scoreMatch({ ...cursor, dateScore }),
        );
      }
    }
  });
});

describe.skipIf(!isTestDatabaseAvailable())("the matcher, end to end", () => {
  let db: Database;

  const DOC = "f0000000-0000-0000-0000-0000000000c1";
  const PAYMENT = "c0000000-0000-0000-0000-0000000000c1";
  const LATER_PAYMENT = "c0000000-0000-0000-0000-0000000000c2";

  beforeEach(async () => {
    db = await getTestDatabase();
    await cleanDatabase();
    await seedAll(db);
    await db.delete(transactions);
  });

  async function makePayment(
    id: string,
    overrides: { date: string; amount?: number },
  ) {
    await db.insert(transactions).values({
      id,
      date: overrides.date,
      name: "TEXACO REED BE2840 REET",
      method: "card_purchase",
      amount: overrides.amount ?? -74.21,
      currency: "USD",
      teamId: TEAM_USD_ID,
      bankAccountId: BANK_USD_CHECKING_ID,
      internalId: `ff1565-${id}`,
      status: "posted",
      merchantName: "Texaco",
    });
  }

  async function makeInvoice(date: string) {
    await db.insert(inbox).values({
      id: DOC,
      teamId: TEAM_USD_ID,
      displayName: "Horbo",
      amount: 74.21,
      currency: "USD",
      date,
      type: "invoice",
      status: "pending",
    });
  }

  test("offers the station's operating company against the card line", async () => {
    await makePayment(PAYMENT, { date: "2026-03-01" });
    await makeInvoice("2026-03-02");

    const match = await findMatches(db, {
      teamId: TEAM_USD_ID,
      inboxId: DOC,
    });

    expect(match?.transactionId).toBe(PAYMENT);
  });

  test("offers nothing when the only payment of that size is months away", async () => {
    await makePayment(LATER_PAYMENT, { date: "2026-06-20" });
    await makeInvoice("2026-03-02");

    const match = await findMatches(db, {
      teamId: TEAM_USD_ID,
      inboxId: DOC,
    });

    expect(match).toBeNull();
  });
});
