import { describe, expect, test } from "bun:test";
import type { YukiCardCharge } from "@midday/yuki";
import {
  cardChargeWindow,
  countCharges,
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
    // card fees included. The original is recorded beside it.
    expect(transaction?.amount).toBe(-25.57);
    expect(transaction?.currency).toBe("EUR");
  });

  test("records what a foreign charge originally cost, as data", () => {
    const [transaction] = toUpsertTransactions([
      charge({
        amount: -25.57,
        foreign: { currency: "USD", amount: -29, rate: 1.13 },
      }),
    ]);

    // It used to be the sentence `USD 29.00 at 1.13` written into
    // `description`, which nothing could format, convert or query (FF-1560).
    expect(transaction?.original_amount).toBe(29);
    expect(transaction?.original_currency).toBe("USD");
    expect(transaction?.exchange_rate).toBe(1.13);
  });

  test("leaves description empty rather than restating the conversion", () => {
    const [transaction] = toUpsertTransactions([
      charge({
        merchant: "CURSOR AI",
        // The real shape: Yuki's description is what the conversion is parsed
        // *out of*, so passing it through would swap `USD 18.60 at 1.15` for a
        // longer restatement of the same thing in Dutch.
        description:
          "MASTERCARD - Kaartverrichtingen - CURSOR AI - Vreemde valuta: USD -18,60 Wisselkoers: 1,1553 - CURSOR AI",
        foreign: { currency: "USD", amount: -18.6, rate: 1.1553 },
      }),
    ]);

    expect(transaction?.description).toBeNull();

    // Because every part of that string is already a field of its own.
    expect(transaction?.name).toBe("CURSOR AI");
    expect(transaction?.method).toBe("card_purchase");
    expect(transaction?.original_amount).toBe(18.6);
    expect(transaction?.exchange_rate).toBe(1.1553);
  });

  test("stores no number it could not parse", () => {
    const [transaction] = toUpsertTransactions([
      charge({
        // What a shape nobody anticipated leaves behind. Harmless while this was
        // prose; `numeric` accepts NaN, so a column would have kept it.
        foreign: { currency: "USD", amount: Number.NaN, rate: Number.NaN },
      }),
    ]);

    expect(transaction?.original_amount).toBeNull();
    expect(transaction?.exchange_rate).toBeNull();
    // The currency is still known, and still worth saying.
    expect(transaction?.original_currency).toBe("USD");
  });

  test("a charge already in euro is not a conversion", () => {
    const [transaction] = toUpsertTransactions([
      charge({ foreign: { currency: "EUR", amount: -21.4, rate: 1 } }),
    ]);

    expect(transaction?.original_amount).toBeNull();
    expect(transaction?.original_currency).toBeNull();
    expect(transaction?.exchange_rate).toBeNull();
  });

  test("says nothing about currency for a charge made in euro", () => {
    const [transaction] = toUpsertTransactions([charge()]);

    expect(transaction?.original_amount).toBeNull();
    expect(transaction?.original_currency).toBeNull();
    expect(transaction?.exchange_rate).toBeNull();
  });

  test("the rate is stored so that the original divided by it is the euro", () => {
    const [transaction] = toUpsertTransactions([
      // The worked example from the ticket: $18.60 billed as €16.10.
      charge({
        amount: -16.1,
        foreign: { currency: "USD", amount: -18.6, rate: 1.1553 },
      }),
    ]);

    const original = transaction?.original_amount ?? 0;
    const rate = transaction?.exchange_rate ?? 1;

    expect(original / rate).toBeCloseTo(Math.abs(transaction?.amount ?? 0), 2);
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
