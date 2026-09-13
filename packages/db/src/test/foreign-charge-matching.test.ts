/**
 * What the matcher does with a charge made in another currency (FF-1561).
 *
 * Two shapes, both measured on the live books on 2026-09-13, and the matcher got
 * both wrong for the same underlying reason — it compared amounts without asking
 * whether an exchange rate stood between them.
 *
 * **A document in the currency the charge was originally made in.** Eight pending
 * suggestions, all a USD invoice against a euro card charge. Six of them agree
 * with the charge's original dollar amount **to the cent**, and all eight scored
 * 0.738 — because a dollar invoice and a euro charge cannot be reconciled without
 * the original, which the transaction did not carry until FF-1560.
 *
 * **A document already in the settled currency.** Four pending suggestions, euro
 * against euro, gaps of 1.99% to 2.69%. Those two euro figures differ by
 * construction: the accountant books the invoice at the invoice-date rate and the
 * card issuer converts at its own rate on settlement day with its margin in it.
 * Every one was confirmed correct by hand, and they scored 0.89 to 0.94 — under
 * the 0.95 the bulk-confirm script requires.
 *
 * No database: this is arithmetic, and the seam is the scorer.
 */
import { describe, expect, test } from "bun:test";
import {
  alignAmounts,
  calculateAmountScore,
  isExactAmountMatch,
  scoreMatch,
} from "../utils/transaction-matching";

/** The Cursor charge from the ticket: $18.60 billed as €16.10. */
const euroCardCharge = {
  amount: -16.1,
  currency: "EUR",
  originalAmount: 18.6,
  originalCurrency: "USD",
  exchangeRate: 1.1553,
};

/** An ordinary domestic payment, for the comparisons that must not change. */
const domesticPayment = {
  amount: -16.1,
  currency: "EUR",
  originalAmount: null,
  originalCurrency: null,
};

describe("a document billed in the currency the charge was made in", () => {
  test("is compared in that currency, where it is exact", () => {
    // The GitHub case: a $100 invoice against a €86.76 charge. Six live pairs
    // look like this and every one agrees to the cent on the dollar figure.
    const invoice = { amount: 100, currency: "USD" };
    const charge = {
      amount: -86.76,
      currency: "EUR",
      originalAmount: 100,
      originalCurrency: "USD",
    };

    expect(alignAmounts(invoice, charge)).toEqual({
      amount1: 100,
      amount2: 100,
      acrossRates: false,
    });
    expect(calculateAmountScore(invoice, charge)).toBe(1.0);
    expect(isExactAmountMatch(invoice, charge)).toBe(true);
  });

  test("scores as the certain match it is, rather than 0.738", () => {
    const invoice = { amount: 100, currency: "USD" };
    const charge = {
      amount: -86.76,
      currency: "EUR",
      originalAmount: 100,
      originalCurrency: "USD",
    };

    const confidence = scoreMatch({
      nameScore: 0.9,
      amountScore: calculateAmountScore(invoice, charge),
      dateScore: 1,
      currencyScore: 0.8,
      isSameCurrency: false,
      isExactAmount: isExactAmountMatch(invoice, charge),
    });

    // Above the 0.95 the bulk-confirm script requires.
    expect(confidence).toBeGreaterThan(0.95);
  });

  test("a genuinely different amount is still not a match", () => {
    // Two live pairs look like this: an $8.84 document against a $10.00 charge.
    // Comparing the originals is not a concession — it makes the disagreement
    // visible where euro-against-euro hid it.
    const invoice = { amount: 8.84, currency: "USD" };
    const charge = {
      amount: -8.62,
      currency: "EUR",
      originalAmount: 10,
      originalCurrency: "USD",
    };

    expect(isExactAmountMatch(invoice, charge)).toBe(false);
    expect(calculateAmountScore(invoice, charge)).toBeLessThan(0.85);
  });
});

describe("a document already in the settled currency", () => {
  test("is not marked down for the spread between two rates", () => {
    // 2.35% apart, the middle of the live band. It used to score 0.85, which is
    // what dragged a correct match to 0.92.
    const invoice = { amount: 15.72, currency: "EUR" };

    expect(calculateAmountScore(invoice, euroCardCharge)).toBe(0.95);
  });

  test("the same gap on a domestic payment is left exactly as it was", () => {
    // The concession is for a charge that was actually converted, never for two
    // amounts in one currency that simply differ.
    const invoice = { amount: 15.72, currency: "EUR" };

    expect(calculateAmountScore(invoice, domesticPayment)).toBe(0.85);
  });

  test("the concession is bounded, not an open band", () => {
    // 8% apart is not a spread — no pair of rates for one currency pair is that
    // far apart, so this is a different amount and still scores as one.
    const invoice = { amount: 14.81, currency: "EUR" };

    expect(calculateAmountScore(invoice, euroCardCharge)).toBeLessThan(0.7);
  });

  test("a gap the rates do not explain stays below 0.90", () => {
    // The band below 0.90 was correctly scored and must stay that way.
    const invoice = { amount: 11.3, currency: "EUR" };

    const confidence = scoreMatch({
      nameScore: 0.9,
      amountScore: calculateAmountScore(invoice, euroCardCharge),
      dateScore: 1,
      currencyScore: 1,
      isSameCurrency: true,
      isExactAmount: false,
    });

    expect(confidence).toBeLessThan(0.9);
  });
});

describe("what exactness means across currencies", () => {
  test("two amounts that merely read the same are not the same money", () => {
    // This is the expression that used to sit inline at six call sites: it
    // subtracted the two amounts whatever currency they were in, so a $100
    // invoice and a €100 charge took the 0.92 floor with them.
    const invoice = { amount: 100, currency: "USD" };
    const charge = { amount: -100, currency: "EUR" };

    expect(isExactAmountMatch(invoice, charge)).toBe(false);
  });

  test("the same currency on both sides is unchanged", () => {
    expect(
      isExactAmountMatch(
        { amount: 16.1, currency: "EUR" },
        { amount: -16.1, currency: "EUR" },
      ),
    ).toBe(true);
  });

  test("nothing to align is not an exact match", () => {
    expect(
      isExactAmountMatch(
        { amount: null, currency: "EUR" },
        { amount: -16.1, currency: "EUR" },
      ),
    ).toBe(false);
  });

  test("a document whose currency was never extracted is compared as before", () => {
    // Refusing this would take the confidence floor away from matches that used
    // to have it, for a reason that has nothing to do with exchange rates: we
    // cannot say the currencies differ, so we do not.
    expect(
      isExactAmountMatch(
        { amount: 120, currency: null },
        { amount: -120, currency: "EUR" },
      ),
    ).toBe(true);
  });

  test("two amounts of zero are what they always were", () => {
    expect(
      isExactAmountMatch(
        { amount: 0, currency: "EUR" },
        { amount: 0, currency: "EUR" },
      ),
    ).toBe(true);
  });

  test("the answer does not depend on the order of the arguments", () => {
    // Three of the six call sites pass (transaction, document) rather than
    // (document, transaction).
    const invoice = { amount: 100, currency: "USD" };
    const charge = {
      amount: -86.76,
      currency: "EUR",
      originalAmount: 100,
      originalCurrency: "USD",
    };

    expect(isExactAmountMatch(charge, invoice)).toBe(
      isExactAmountMatch(invoice, charge),
    );
    expect(calculateAmountScore(charge, invoice)).toBe(
      calculateAmountScore(invoice, charge),
    );
  });

  test("a converted charge with no original amount still gets the wider band", () => {
    // GoCardless sends the currency and the rate and never an amount. The euro
    // figure still got there through a rate, so the spread argument holds.
    const invoice = { amount: 15.72, currency: "EUR" };
    const charge = {
      amount: -16.1,
      currency: "EUR",
      originalAmount: null,
      originalCurrency: "USD",
    };

    expect(calculateAmountScore(invoice, charge)).toBe(0.95);
  });
});

describe("the rate direction FF-1560 settled", () => {
  test("the original divided by the rate is the amount that was charged", () => {
    const { originalAmount, exchangeRate, amount } = euroCardCharge;

    expect(originalAmount / exchangeRate).toBeCloseTo(Math.abs(amount), 2);
  });
});
