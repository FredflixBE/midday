import { describe, expect, test } from "bun:test";
import { isExpired } from "./version";

describe("expired", () => {
  test("a sent version is expired the day after its validity date", () => {
    const sent = { status: "sent" as const, validUntil: "2026-09-30" };
    expect(isExpired(sent, "2026-09-30")).toBe(false);
    expect(isExpired(sent, "2026-10-01")).toBe(true);
  });

  test("only a sent version expires", () => {
    for (const status of ["draft", "superseded", "accepted"] as const) {
      expect(
        isExpired({ status, validUntil: "2026-01-01" }, "2026-10-01"),
      ).toBe(false);
    }
  });
});
