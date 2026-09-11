import { describe, expect, test } from "bun:test";
import { syncStartBounds, syncStartProblem } from "./sync-start";

describe("the dates a first sync may start from", () => {
  test("reach back one year, and default to thirty days", () => {
    expect(syncStartBounds("2026-09-11")).toEqual({
      earliest: "2025-09-11",
      latest: "2026-09-11",
      suggested: "2026-08-12",
    });
  });

  test("end on the 28th of February a year after a leap day", () => {
    expect(syncStartBounds("2025-02-28").earliest).toBe("2024-02-28");
    expect(syncStartBounds("2028-02-29").earliest).toBe("2027-02-28");
  });
});

describe("a start date the server is asked to sync from", () => {
  const now = new Date("2026-09-11T12:00:00Z");

  test("is accepted anywhere in the last year", () => {
    expect(syncStartProblem("2025-09-11", now)).toBeNull();
    expect(syncStartProblem("2026-03-01", now)).toBeNull();
    expect(syncStartProblem("2026-09-11", now)).toBeNull();
  });

  test("is refused when it is more than a year back", () => {
    expect(syncStartProblem("2025-06-01", now)).toBe(
      "An inbox sync can reach back at most one year, to 2025-09-11; 2025-06-01 is further back.",
    );
  });

  test("is refused when it is in the future", () => {
    expect(syncStartProblem("2026-10-01", now)).toBe(
      "An inbox sync cannot start in the future; 2026-10-01 is after 2026-09-11.",
    );
  });

  test("allows a day either side for the user's time zone", () => {
    // Late evening in Belgium is already tomorrow, early morning in
    // California is still yesterday: the picker works in the user's day.
    expect(syncStartProblem("2026-09-12", now)).toBeNull();
    expect(syncStartProblem("2025-09-10", now)).toBeNull();
    expect(syncStartProblem("2025-09-09", now)).not.toBeNull();
  });

  test("is refused when it is not a calendar date", () => {
    expect(syncStartProblem("2026-02-30", now)).toBe(
      "2026-02-30 is not a date; use YYYY-MM-DD.",
    );
    expect(syncStartProblem("11/09/2026", now)).toBe(
      "11/09/2026 is not a date; use YYYY-MM-DD.",
    );
  });
});
