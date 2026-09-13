/**
 * The sentence a foreign-currency charge is described by (FF-1560).
 *
 * Worth testing as text rather than as a rendered component, because the wording
 * is the defect: `USD 18.60 at 1.15` carried a rate nobody could read, never said
 * the two amounts were the same money, and had no label.
 *
 * It says one thing, and deliberately only one: what the supplier billed. The
 * first version also showed an exchange rate, and reading it against the real
 * books Frederik's verdict was that it "doesn't add any meaningful information".
 * The measurement agreed — see `formatConversion` for why a rate that does not
 * reconcile with the amounts beside it is worse than no rate at all.
 */
import { expect, test } from "bun:test";
import { formatConversion } from "./format";

const cursor = {
  // The real charge from the live books: $19.95 billed, €17.57 taken.
  originalAmount: 19.95,
  originalCurrency: "USD",
  currency: "EUR",
  locale: "en-US",
};

test("says what the supplier billed, and nothing else", () => {
  expect(formatConversion(cursor)).toBe("Originally $19.95");
});

test("says nothing when there was no conversion", () => {
  expect(
    formatConversion({
      originalAmount: null,
      originalCurrency: null,
      currency: "EUR",
    }),
  ).toBeNull();
});

test("says nothing when the original currency is the one charged", () => {
  // Nothing was converted, so the amount above already says it.
  expect(
    formatConversion({ ...cursor, originalCurrency: "EUR", currency: "EUR" }),
  ).toBeNull();
});

test("says nothing when the currency is known but the amount is not", () => {
  // GoCardless sends a currency and no instructed amount. "Charged in USD" on
  // its own tells a reader nothing they can act on.
  expect(formatConversion({ ...cursor, originalAmount: null })).toBeNull();
});

test("formats to the reader's locale, not to ours", () => {
  // A Belgian reader sees the comma, which is the whole reason this is data and
  // not a string written by the importer.
  expect(formatConversion({ ...cursor, locale: "nl-BE" })).toContain("19,95");
});
