import { expect, test } from "bun:test";
import {
  formatAdjustment,
  formatHours,
  formatQuoteAmount,
  toWorkTypeRates,
} from "./quote-pricing";

/** Intl separates symbol and number with a no-break space; compare on content. */
const plain = (value: string) => value.replace(/\s/g, " ");

test("rates are every work type's default, archived ones included, and the customer's own", () => {
  const rates = toWorkTypeRates(
    [
      { id: "p-1", hourlyRate: 100 },
      { id: "p-2", hourlyRate: 85.5 },
    ],
    [{ workTypeId: "p-2", hourlyRate: 90 }],
  );

  expect(rates).toEqual({
    defaults: { "p-1": 100, "p-2": 85.5 },
    customer: { "p-2": 90 },
  });
});

test("rates not loaded yet are no rates, so pricing reports them missing", () => {
  expect(toWorkTypeRates(undefined, undefined)).toEqual({
    defaults: {},
    customer: {},
  });
});

test("an amount in cents reads in the currency, without cents when whole", () => {
  expect(
    plain(formatQuoteAmount({ amount: 120000, max: null }, "EUR", "nl-BE")),
  ).toBe("€ 1.200");
  expect(
    plain(formatQuoteAmount({ amount: 12050, max: null }, "EUR", "nl-BE")),
  ).toBe("€ 120,50");
});

test("a range reads minimum to maximum", () => {
  expect(
    plain(formatQuoteAmount({ amount: 100000, max: 150000 }, "EUR", "nl-BE")),
  ).toBe("€ 1.000 – € 1.500");
});

test("a range whose ends meet reads as one amount", () => {
  expect(
    plain(formatQuoteAmount({ amount: 100000, max: 100000 }, "EUR", "nl-BE")),
  ).toBe("€ 1.000");
});

test("hours read to the hundredth, a range as minimum to maximum", () => {
  expect(formatHours({ amount: 7.5, max: null }, "en")).toBe("7.5");
  expect(formatHours({ amount: 8, max: 12 }, "en")).toBe("8 – 12");
});

test("an adjustment carries its sign, so a surcharge is told from a discount", () => {
  expect(formatAdjustment(5, "en")).toBe("+5%");
  expect(formatAdjustment(-5, "en")).toBe("-5%");
  expect(formatAdjustment(0, "en")).toBe("0%");
});
