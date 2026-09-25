import { describe, expect, test } from "bun:test";
import {
  fromEnableBankingError,
  getProviderErrorDetails,
  ProviderError,
} from "./error";

// What xior throws for Enable Banking's reply when the bank behind it refuses,
// as logged by the API on 2026-09-23.
function aspspRefusal() {
  return Object.assign(new Error("Request failed with status code 400"), {
    response: {
      status: 400,
      data: {
        message: "Error interacting with ASPSP",
        code: 400,
        error: "ASPSP_ERROR",
        detail: "Unknown error",
      },
    },
  });
}

describe("ProviderError", () => {
  test("names a bank refusal instead of calling it unknown", () => {
    const error = new ProviderError({
      message: "refused",
      code: "ASPSP_ERROR",
    });

    expect(error.code).toBe("bank_error");
  });
});

describe("fromEnableBankingError", () => {
  test("turns Enable Banking's ASPSP_ERROR into a bank_error", () => {
    const error = fromEnableBankingError(aspspRefusal());

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe("bank_error");
  });

  test("keeps what Enable Banking said, so the job's error can repeat it", () => {
    const error = fromEnableBankingError(aspspRefusal()) as ProviderError;

    expect(error.message).toBe(
      "Enable Banking 400 ASPSP_ERROR: Error interacting with ASPSP (Unknown error)",
    );
  });

  test("leaves an error with no Enable Banking reply alone", () => {
    const network = new Error("fetch failed");

    expect(fromEnableBankingError(network)).toBe(network);
  });

  test("still logs the status and body of the reply it wrapped", () => {
    const details = getProviderErrorDetails(
      fromEnableBankingError(aspspRefusal()),
    );

    expect(details.status).toBe(400);
    expect(details.providerError).toEqual(aspspRefusal().response.data);
  });
});
