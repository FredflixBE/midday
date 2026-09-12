import { describe, expect, test } from "bun:test";
import type { YukiCardCharge } from "@midday/yuki";
import {
  cardChargeWindow,
  countCharges,
  foreignAmountNote,
  toBooksStatusEntries,
  toUpsertTransactions,
} from "./yuki-card-charges";

function charge(overrides: Partial<YukiCardCharge> = {}): YukiCardCharge {
  return {
    id: "ledger-line-1",
    date: "2026-08-16",
    merchant: "EXAMPLE SHOP DUBLIN",
    amount: -21.4,
    currency: "EUR",
    description: "MASTERCARD - Kaartverrichtingen - EXAMPLE SHOP DUBLIN",
    status: "invoice_missing",
    ...overrides,
  };
}

describe("the window a run reads", () => {
  test("reaches back far enough for a statement that arrived late", () => {
    // A charge reaches the books with the monthly statement, up to 36 days
    // after it happened. A window measured in weeks would lose a month.
    expect(cardChargeWindow(new Date("2026-09-12T09:00:00Z"), 400)).toEqual({
      from: "2025-08-08",
      to: "2026-09-13",
    });
  });

  test("ends tomorrow, so a booking dated today is never a coin-flip", () => {
    const { to } = cardChargeWindow(new Date("2026-09-12T23:30:00Z"), 30);
    expect(to).toBe("2026-09-13");
  });
});

describe("a charge as an ordinary transaction", () => {
  test("carries the ledger line's id, so a re-run duplicates nothing", () => {
    expect(toUpsertTransactions([charge()])[0]?.id).toBe("ledger-line-1");
  });

  test("keeps the euro the card issuer actually took", () => {
    const [transaction] = toUpsertTransactions([
      charge({
        amount: -25.57,
        foreign: { currency: "USD", amount: -29, rate: 1.13 },
      }),
    ]);

    // Not -29 converted by us: 25.57 is what the books hold, conversion and
    // card fees included. The original is shown beside it.
    expect(transaction?.amount).toBe(-25.57);
    expect(transaction?.description).toBe("USD 29.00 at 1.13");
  });

  test("says nothing about currency for a charge made in euro", () => {
    expect(foreignAmountNote(charge())).toBeNull();
  });

  test("prefers the name the accountant gave the counterparty", () => {
    const [transaction] = toUpsertTransactions([
      charge({ contactName: "Example Shop Ltd." }),
    ]);

    // The statement's own text stays the transaction's name, exactly as a
    // bank feed would have it; the tidy name is what an invoice is matched on.
    expect(transaction?.name).toBe("EXAMPLE SHOP DUBLIN");
    expect(transaction?.counterparty_name).toBe("Example Shop Ltd.");
    expect(transaction?.merchant_name).toBe("Example Shop Ltd.");
  });

  test("falls back to the statement's merchant when nobody has named one", () => {
    const [transaction] = toUpsertTransactions([charge()]);

    expect(transaction?.counterparty_name).toBe("EXAMPLE SHOP DUBLIN");
    expect(transaction?.merchant_name).toBeNull();
  });

  test("is a card purchase, posted, in no category yet", () => {
    expect(toUpsertTransactions([charge()])[0]).toMatchObject({
      method: "card_purchase",
      status: "posted",
      category: null,
      balance: null,
    });
  });
});

describe("what a run reports", () => {
  const charges = [
    charge({ id: "a", status: "invoice_missing" }),
    charge({ id: "b", status: "in_the_books" }),
    charge({ id: "c", status: "in_the_books" }),
    charge({
      id: "d",
      status: "needs_attention",
      attentionReason: "no_counterpart_line",
    }),
  ];

  test("counts each status, which is what the Admin button shows", () => {
    expect(countCharges(charges)).toEqual({
      total: 4,
      invoiceMissing: 1,
      inTheBooks: 2,
      needsAttention: 1,
    });
  });

  test("carries the reason through, for the charge nobody could decide", () => {
    expect(toBooksStatusEntries(charges)).toEqual([
      { sourceId: "a", status: "invoice_missing", reason: undefined },
      { sourceId: "b", status: "in_the_books", reason: undefined },
      { sourceId: "c", status: "in_the_books", reason: undefined },
      {
        sourceId: "d",
        status: "needs_attention",
        reason: "no_counterpart_line",
      },
    ]);
  });
});
