import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { retryCall } from "./retry";

/** An operation that fails with `error` the first `failures` times. */
function failing(error: () => unknown, failures: number) {
  let calls = 0;
  const operation = async () => {
    calls += 1;
    if (calls <= failures) throw error();
    return "ok";
  };
  return { operation, calls: () => calls };
}

describe("retryCall", () => {
  test("tries again when the answer did not fit the schema", async () => {
    const { operation, calls } = failing(
      () => z.object({ total: z.number() }).safeParse({ total: "12" }).error,
      1,
    );

    expect(await retryCall(operation, 2, 1)).toBe("ok");
    expect(calls()).toBe(2);
  });

  test("tries again when the model produced no object", async () => {
    const { operation, calls } = failing(() => {
      const error = new Error(
        "No object generated: response did not match schema.",
      );
      error.name = "AI_NoObjectGeneratedError";
      return error;
    }, 1);

    expect(await retryCall(operation, 2, 1)).toBe("ok");
    expect(calls()).toBe(2);
  });

  test("does not retry a request the API refused", async () => {
    const { operation, calls } = failing(
      () => new Error("invalid x-api-key"),
      1,
    );

    await expect(retryCall(operation, 2, 1)).rejects.toThrow(
      "invalid x-api-key",
    );
    expect(calls()).toBe(1);
  });
});
