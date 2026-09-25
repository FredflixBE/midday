/**
 * The tracker's date range comes from URL state (nuqs), so sorting it must
 * not reorder the array the caller passed in (FF-1707).
 */
import { expect, test } from "bun:test";
import { getTrackerDates, sortDates } from "./tracker";

test("sortDates returns the dates in order and leaves its input alone", () => {
  const range = ["2026-09-12", "2026-09-03"];

  expect(sortDates(range)).toEqual(["2026-09-03", "2026-09-12"]);
  expect(range).toEqual(["2026-09-12", "2026-09-03"]);
});

test("getTrackerDates does not reorder the range it is given", () => {
  const range = ["2026-09-12", "2026-09-03"];

  const dates = getTrackerDates(range, null);

  expect(dates.map((date) => date.toISOString().slice(0, 10))).toEqual([
    "2026-09-03",
    "2026-09-12",
  ]);
  expect(range).toEqual(["2026-09-12", "2026-09-03"]);
});
