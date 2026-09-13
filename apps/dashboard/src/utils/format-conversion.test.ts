/**
 * The sentence a foreign-currency charge is described by (FF-1560).
 *
 * Worth testing as text rather than as a rendered component, because the wording
 * is the defect: `USD 18.60 at 1.15` gave the rate no direction, never said the
 * two amounts were the same money, and carried no label.
 */
import { expect, test } from "bun:test";
import { formatConversion } from "./format";

const cursor = {
  // The worked example from the ticket: $18.60 billed as €16.10.
  originalAmount: 18.6,
  originalCurrency: "USD",
  exchangeRate: 1.1553,
  currency: "EUR",
  locale: "en-US",
};

test("says what it originally cost and which way the rate goes", () => {
  expect(formatConversion(cursor)).toBe(
    "Originally $18.60 · 1 EUR = 1.1553 USD",
  );
});

test("a rate that happens to be round does not grow decimals", () => {
  expect(formatConversion({ ...cursor, exchangeRate: 1.2 })).toBe(
    "Originally $18.60 · 1 EUR = 1.2 USD",
  );
});

test("a long rate is cut to four decimals, not to two", () => {
  // Two would round 1.1553 to 1.16, which re-derives the wrong euro amount —
  // the reason the column is wider than the money columns.
  expect(formatConversion({ ...cursor, exchangeRate: 1.155312345 })).toBe(
    "Originally $18.60 · 1 EUR = 1.1553 USD",
  );
});

test("without a rate it still says what was charged", () => {
  // GoCardless sends a rate whose direction cannot always be established, and
  // drops it rather than guess. The amount is the useful part anyway.
  expect(formatConversion({ ...cursor, exchangeRate: null })).toBe(
    "Originally $18.60",
  );
});

test("a rate with no amount still says which currency it was charged in", () => {
  // GoCardless sends the rate and the currency it converted from, and never an
  // instructed amount. A column filled and never shown would be the same
  // problem in a new place.
  expect(formatConversion({ ...cursor, originalAmount: null })).toBe(
    "Charged in USD · 1 EUR = 1.1553 USD",
  );
});

test("a currency on its own is still the cue that this is a conversion", () => {
  expect(
    formatConversion({ ...cursor, originalAmount: null, exchangeRate: null }),
  ).toBe("Charged in USD");
});

test("says nothing when there was no conversion", () => {
  expect(
    formatConversion({
      originalAmount: null,
      originalCurrency: null,
      exchangeRate: null,
      currency: "EUR",
    }),
  ).toBeNull();
});

test("says nothing when the original currency is the one charged", () => {
  // Nothing was converted, whatever the payload carried.
  expect(
    formatConversion({ ...cursor, originalCurrency: "EUR", currency: "EUR" }),
  ).toBeNull();
});

test("formats the original to the reader's locale, not to ours", () => {
  // A Belgian reader sees the comma, which is the whole reason this is data and
  // not a string written by the importer.
  expect(formatConversion({ ...cursor, locale: "nl-BE" })).toContain("18,60");
});
