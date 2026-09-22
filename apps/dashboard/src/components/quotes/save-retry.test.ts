import { describe, expect, test } from "bun:test";
import { MAX_SAVE_ATTEMPTS, planRetry } from "./save-retry";

/** What a refused tRPC mutation looks like to the caller. */
const refused = (code?: string) =>
  code
    ? { message: "Refused", data: { code } }
    : { message: "Failed to fetch" };

describe("planRetry", () => {
  test("a network blip carries no code, and is tried again", () => {
    expect(planRetry(refused(), 1)).toEqual({ retry: true, delayMs: 1000 });
  });

  test("backs off, doubling each time", () => {
    const delays = [1, 2, 3, 4].map((failures) => {
      const decision = planRetry(refused(), failures);
      return decision.retry ? decision.delayMs : null;
    });
    expect(delays).toEqual([1000, 2000, 4000, 8000]);
  });

  test("gives up on the last attempt rather than waiting again", () => {
    expect(planRetry(refused(), MAX_SAVE_ATTEMPTS)).toEqual({ retry: false });
  });

  test("keeps trying a server error, which the next attempt may not hit", () => {
    for (const code of [
      "INTERNAL_SERVER_ERROR",
      "TIMEOUT",
      "TOO_MANY_REQUESTS",
      "SERVICE_UNAVAILABLE",
    ]) {
      expect(planRetry(refused(code), 1)).toEqual({
        retry: true,
        delayMs: 1000,
      });
    }
  });

  test("never retries a refusal the same payload will earn again", () => {
    for (const code of [
      "BAD_REQUEST",
      "UNAUTHORIZED",
      "FORBIDDEN",
      "NOT_FOUND",
      "CONFLICT",
      "PAYLOAD_TOO_LARGE",
      "UNPROCESSABLE_CONTENT",
    ]) {
      expect(planRetry(refused(code), 1)).toEqual({ retry: false });
    }
  });

  test("reads a code that is not a string as one it does not know", () => {
    expect(planRetry({ message: "odd", data: { code: 42 } }, 1)).toEqual({
      retry: true,
      delayMs: 1000,
    });
    expect(planRetry(null, 1)).toEqual({ retry: true, delayMs: 1000 });
  });
});
