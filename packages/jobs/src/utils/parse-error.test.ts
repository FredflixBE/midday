import { describe, expect, test } from "bun:test";
import { isBankRefusal, parseAPIError } from "./parse-error";

// The shape a TRPCClientError reaches the job in: the API's JSON as its message.
function apiError(body: Record<string, unknown>) {
  return new Error(JSON.stringify(body));
}

describe("parseAPIError", () => {
  test("repeats what the provider said after what failed", () => {
    const parsed = parseAPIError(
      apiError({
        message: "Failed to get provider transactions",
        providerCode: "bank_error",
        providerMessage:
          "Enable Banking 400 ASPSP_ERROR: Error interacting with ASPSP (Unknown error)",
      }),
    );

    expect(parsed).toEqual({
      code: "bank_error",
      message:
        "Failed to get provider transactions: Enable Banking 400 ASPSP_ERROR: Error interacting with ASPSP (Unknown error)",
    });
  });

  test("reads an API one version behind, which sends no provider message", () => {
    const parsed = parseAPIError(
      apiError({
        message: "Failed to get account balance",
        providerCode: "unknown",
      }),
    );

    expect(parsed).toEqual({
      code: "unknown",
      message: "Failed to get account balance",
    });
  });
});

describe("isBankRefusal", () => {
  test("is true for a bank_error", () => {
    expect(
      isBankRefusal(
        parseAPIError(
          apiError({ message: "failed", providerCode: "bank_error" }),
        ),
      ),
    ).toBe(true);
  });

  test("is false for anything else", () => {
    expect(isBankRefusal(parseAPIError(new Error("fetch failed")))).toBe(false);
  });
});
