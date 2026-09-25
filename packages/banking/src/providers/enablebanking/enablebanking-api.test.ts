import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";

// A throwaway key, so the client can sign its JWT without real credentials.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.ENABLEBANKING_APPLICATION_ID ??= "test-application";
process.env.ENABLE_BANKING_KEY_CONTENT ??= Buffer.from(
  privateKey.export({ type: "pkcs8", format: "pem" }),
).toString("base64");
process.env.ENABLEBANKING_REDIRECT_URL ??= "https://midday.test/callback";

// Required rather than imported: `env` validates these on load, and an import
// would be hoisted above the lines that set them.
const { EnableBankingApi } =
  require("./enablebanking-api") as typeof import("./enablebanking-api");
const { ProviderError } =
  require("../../utils/error") as typeof import("../../utils/error");

const originalFetch = globalThis.fetch;

let requests: string[];

// Enable Banking's reply when the bank behind it refuses, for every request.
function bankRefuses() {
  return mock(async (input: string | URL | Request) => {
    requests.push(new URL(String(input)).pathname);
    return new Response(
      JSON.stringify({
        message: "Error interacting with ASPSP",
        code: 400,
        error: "ASPSP_ERROR",
        detail: "Unknown error",
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  });
}

beforeEach(() => {
  requests = [];
  globalThis.fetch = bankRefuses() as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Only the transaction reads: the balance call also asks for the account's
// details, and that request can land after its own test has finished.
function transactionReads() {
  return requests.filter((path) => path.endsWith("/transactions"));
}

async function caught(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("EnableBankingApi when the bank refuses", () => {
  test("reports the balance call's refusal as a bank_error", async () => {
    const error = await caught(
      new EnableBankingApi().getAccountBalance("account-1"),
    );

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as InstanceType<typeof ProviderError>).code).toBe(
      "bank_error",
    );
  });

  test("asks for the full history once, not again through the one-year fallback", async () => {
    const error = await caught(
      new EnableBankingApi().getTransactions({
        accountId: "account-1",
        accountType: "depository",
        latest: false,
      }),
    );

    expect((error as InstanceType<typeof ProviderError>).code).toBe(
      "bank_error",
    );
    expect(transactionReads()).toEqual(["/accounts/account-1/transactions"]);
  });

  test("asks for the recent window once", async () => {
    const error = await caught(
      new EnableBankingApi().getTransactions({
        accountId: "account-1",
        accountType: "depository",
        latest: true,
      }),
    );

    expect((error as InstanceType<typeof ProviderError>).code).toBe(
      "bank_error",
    );
    expect(transactionReads()).toEqual(["/accounts/account-1/transactions"]);
  });
});
