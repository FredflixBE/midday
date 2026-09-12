import { describe, expect, it } from "bun:test";
import { isYukiDailyLimit, YukiRequestError } from "./errors";

/** Exactly what a live domain answered on 2026-09-12, once the day was spent. */
const DAILY_LIMIT = new YukiRequestError({
  operation: "ModifiedDocumentsInFolder",
  message: "ModifiedDocumentsInFolder faulted: Daily limit exceeded",
  faultString: "Daily limit exceeded",
});

describe("isYukiDailyLimit", () => {
  it("recognises the fault a spent allowance answers with", () => {
    expect(isYukiDailyLimit(DAILY_LIMIT)).toBe(true);
  });

  it("does not mistake another fault for it", () => {
    expect(
      isYukiDailyLimit(
        new YukiRequestError({
          operation: "DocumentBinaryData",
          message: "DocumentBinaryData faulted: Invalid document ID",
        }),
      ),
    ).toBe(false);
  });

  it("is false for anything that is not a Yuki request error", () => {
    // A message that happens to say the words is not Yuki saying them.
    expect(isYukiDailyLimit(new Error("daily limit exceeded"))).toBe(false);
    expect(isYukiDailyLimit(undefined)).toBe(false);
  });
});
