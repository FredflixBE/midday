/**
 * A date the user has not chosen a format for (FF-1539). It used to render in
 * date-fns' locale-dependent "P", which with the built-in en-US locale puts
 * the month first: 2 October 2025 read as 10 February to a Belgian eye.
 */
import { expect, test } from "bun:test";
import { DEFAULT_DATE_FORMAT, formatDate } from "./format";

test("an unset format puts the day first", () => {
  expect(formatDate("2025-10-02", null)).toBe("02/10/2025");
  expect(formatDate("2025-10-02")).toBe("02/10/2025");
});

test("an unset format is the default one, not a second variant of it", () => {
  expect(formatDate("2025-10-02")).toBe(
    formatDate("2025-10-02", DEFAULT_DATE_FORMAT),
  );
});

test("a chosen format is used as it is", () => {
  expect(formatDate("2025-10-02", "MM/dd/yyyy")).toBe("10/02/2025");
  expect(formatDate("2025-10-02", "yyyy-MM-dd")).toBe("2025-10-02");
});
