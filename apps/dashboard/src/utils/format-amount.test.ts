/**
 * How the app writes an amount (FF-1573).
 *
 * Both users are `nl-BE`, where Intl's default display disambiguates the dollar
 * as "US$". Beside an invoice printed in plain dollars that read as a different
 * figure, so the app asks for the narrow symbol.
 */
import { expect, test } from "bun:test";
import { formatAmount } from "./format";

/** Intl separates symbol and number with a no-break space; compare on content. */
const plain = (value: string | undefined) => value?.replace(/\s/g, " ");

test("a dollar amount reads $, not US$", () => {
  expect(
    plain(formatAmount({ amount: 19.95, currency: "USD", locale: "nl-BE" })),
  ).toBe("$ 19,95");
});

test("a euro amount is unchanged", () => {
  expect(
    plain(formatAmount({ amount: -17.57, currency: "EUR", locale: "nl-BE" })),
  ).toBe("€ -17,57");
});
