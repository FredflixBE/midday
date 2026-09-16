import { describe, expect, test } from "bun:test";
import { billedAmountCorrection } from "./yuki-billed-amount";

/**
 * The real Cursor invoice from the live books: $19.95 billed, booked by the
 * accountant as €17.22. Today's stored USD→EUR rate is 0.8645.
 */
const cursor = {
  booked: { amount: 17.22, currency: "EUR" },
  extracted: { amount: 19.95, currency: "USD", taxAmount: 0 },
  rateToBooked: 0.8645,
};

describe("a pulled invoice billed in another currency", () => {
  test("takes the amount and currency printed on the invoice", () => {
    const result = billedAmountCorrection(cursor);

    expect(result.correct).toBe(true);
    if (!result.correct) return;
    expect(result.update.amount).toBe(19.95);
    expect(result.update.currency).toBe("USD");
  });

  test("keeps the accountant's booked euro, as the base amount", () => {
    // Not thrown away: a conversion into the reporting currency is exactly what
    // base_amount is for.
    const result = billedAmountCorrection(cursor);

    if (!result.correct) throw new Error("expected a correction");
    expect(result.update.baseAmount).toBe(17.22);
    expect(result.update.baseCurrency).toBe("EUR");
  });

  test("takes the invoice's tax, so no euro figure sits on a dollar row", () => {
    const result = billedAmountCorrection({
      ...cursor,
      extracted: { ...cursor.extracted, taxAmount: 1.5 },
    });

    if (!result.correct) throw new Error("expected a correction");
    expect(result.update.taxAmount).toBe(1.5);
  });

  test("normalises a lower-case currency code", () => {
    const result = billedAmountCorrection({
      ...cursor,
      extracted: { ...cursor.extracted, currency: "usd" },
    });

    if (!result.correct) throw new Error("expected a correction");
    expect(result.update.currency).toBe("USD");
  });
});

describe("what leaves Yuki's figures alone", () => {
  test("an invoice in the currency it was booked in", () => {
    // A euro invoice's booked amount already is what was billed.
    expect(
      billedAmountCorrection({
        ...cursor,
        extracted: { amount: 17.22, currency: "EUR", taxAmount: 0 },
      }),
    ).toEqual({ correct: false, reason: "same-currency" });
  });

  test("an extraction that read no currency", () => {
    expect(
      billedAmountCorrection({
        ...cursor,
        extracted: { ...cursor.extracted, currency: null },
      }),
    ).toEqual({ correct: false, reason: "no-currency" });
  });

  test("an extraction that read something that is not a currency code", () => {
    expect(
      billedAmountCorrection({
        ...cursor,
        extracted: { ...cursor.extracted, currency: "$" },
      }),
    ).toEqual({ correct: false, reason: "no-currency" });
  });

  test("an extraction that read no usable amount", () => {
    for (const amount of [null, 0, Number.NaN]) {
      expect(
        billedAmountCorrection({
          ...cursor,
          extracted: { ...cursor.extracted, amount },
        }),
      ).toEqual({ correct: false, reason: "no-amount" });
    }
  });

  test("a row with no booked amount to check the extraction against", () => {
    expect(
      billedAmountCorrection({
        ...cursor,
        booked: { amount: null, currency: "EUR" },
      }),
    ).toEqual({ correct: false, reason: "no-booked-amount" });
  });

  test("no stored rate for the invoice's currency", () => {
    expect(
      billedAmountCorrection({ ...cursor, rateToBooked: undefined }),
    ).toEqual({ correct: false, reason: "no-rate" });
  });

  test("an extraction that read a line item instead of the total", () => {
    // The Cursor invoice lists -$180.05 and $192.63 above its $19.95 total.
    // $180.05 at today's rate is €155.65 against a booked €17.22: not the same
    // invoice total, so the booked figure stands.
    expect(
      billedAmountCorrection({
        ...cursor,
        extracted: { ...cursor.extracted, amount: 180.05 },
      }),
    ).toEqual({ correct: false, reason: "implausible" });
  });
});

describe("a credit note", () => {
  test("stays negative whichever way the extraction reads its total", () => {
    for (const read of [19.95, -19.95]) {
      const result = billedAmountCorrection({
        booked: { amount: -17.22, currency: "EUR" },
        extracted: { amount: read, currency: "USD", taxAmount: null },
        rateToBooked: 0.8645,
      });

      if (!result.correct) throw new Error("expected a correction");
      expect(result.update.amount).toBe(-19.95);
      expect(result.update.baseAmount).toBe(-17.22);
    }
  });
});

describe("the plausibility band", () => {
  test("tolerates a year of the dollar moving", () => {
    // Booked at 1.12 USD per EUR, checked a year later at 1.17: 4.5% apart.
    const result = billedAmountCorrection({
      booked: { amount: 17.81, currency: "EUR" },
      extracted: { amount: 19.95, currency: "USD", taxAmount: null },
      rateToBooked: 1 / 1.17,
    });

    expect(result.correct).toBe(true);
  });

  test("rejects a total 20% away from the booked one", () => {
    const result = billedAmountCorrection({
      booked: { amount: 17.22, currency: "EUR" },
      extracted: { amount: 19.95 * 1.2, currency: "USD", taxAmount: null },
      rateToBooked: 0.8645,
    });

    expect(result).toEqual({ correct: false, reason: "implausible" });
  });
});
