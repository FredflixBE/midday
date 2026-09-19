import { expect, test } from "bun:test";
import { formatUnitRate } from "./hourly-rate";
import {
  formatAdjustment,
  formatHours,
  formatQuantityWithUnit,
  formatQuoteAmount,
  toProductRates,
} from "./quote-pricing";

/** Intl separates symbol and number with a no-break space; compare on content. */
const plain = (value: string) => value.replace(/\s/g, " ");

test("rates are every product's price, inactive ones included, and the customer's own", () => {
  const rates = toProductRates(
    [
      { id: "p-1", price: 100 },
      { id: "p-2", price: 85.5 },
    ],
    [{ productId: "p-2", hourlyRate: 90 }],
  );

  expect(rates).toEqual({
    defaults: { "p-1": 100, "p-2": 85.5 },
    customer: { "p-2": 90 },
  });
});

test("a product without a price has no rate, so pricing reports it missing", () => {
  expect(toProductRates([{ id: "p-1", price: null }], []).defaults).toEqual({});
});

test("rates not loaded yet are no rates", () => {
  expect(toProductRates(undefined, undefined)).toEqual({
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

test("a quote in days reads its hours as days, with the unit named", () => {
  const days = { displayUnit: "days", hoursPerDay: 8 } as const;
  const hours = { displayUnit: "hours", hoursPerDay: 8 } as const;
  expect(formatQuantityWithUnit({ amount: 12, max: null }, days, "en")).toBe(
    "1.5 days",
  );
  expect(formatQuantityWithUnit({ amount: 8, max: null }, days, "en")).toBe(
    "1 day",
  );
  expect(formatQuantityWithUnit({ amount: 8, max: 16 }, days, "en")).toBe(
    "1 – 2 days",
  );
  expect(formatQuantityWithUnit({ amount: 12, max: null }, hours, "en")).toBe(
    "12 h",
  );
});

test("a rate reads per hour, or per day at the quote's hours per day", () => {
  expect(
    plain(
      formatUnitRate(100, "EUR", { displayUnit: "days", hoursPerDay: 7.5 }),
    ),
  ).toBe("€750/day");
  expect(
    plain(formatUnitRate(100, "EUR", { displayUnit: "hours", hoursPerDay: 8 })),
  ).toBe("€100/h");
});

test("an adjustment carries its sign, so a surcharge is told from a discount", () => {
  expect(formatAdjustment(5, "en")).toBe("+5%");
  expect(formatAdjustment(-5, "en")).toBe("-5%");
  expect(formatAdjustment(0, "en")).toBe("0%");
});
