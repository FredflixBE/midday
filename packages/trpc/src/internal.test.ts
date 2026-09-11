import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createInternalClient, SLOW_PROCEDURES } from "./internal";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

type Captured = { url: string; headers: Headers };

// Answers every tRPC request with `{ ok: true }`, in the batched or the
// single-request shape depending on what was asked, and records the request.
function recordingFetch(captured: Captured[]) {
  return mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    captured.push({ url, headers: new Headers(init?.headers) });
    const result = { result: { data: { json: { ok: true } } } };
    const body = url.includes("batch=1") ? [result] : result;
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  });
}

describe("createInternalClient", () => {
  let captured: Captured[];

  beforeEach(() => {
    captured = [];
    process.env.INTERNAL_API_KEY = "test-internal-key";
    process.env.API_INTERNAL_URL = "http://api.test";
    globalThis.fetch = recordingFetch(captured) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  test("sends the bank history fetch on its own, unbatched request", async () => {
    const client = createInternalClient();

    await client.banking.getProviderTransactions.query({
      provider: "enablebanking",
      accountId: "account-1",
      accountType: "depository",
      latest: false,
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toContain(
      "http://api.test/trpc/banking.getProviderTransactions",
    );
    expect(captured[0]?.url).not.toContain("batch=1");
  });

  test("keeps every other call on the batched request", async () => {
    const client = createInternalClient();

    await client.banking.getBalance.query({
      provider: "enablebanking",
      id: "account-1",
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toContain("batch=1");
  });

  test("authenticates the slow request like every other", async () => {
    const client = createInternalClient();

    await client.banking.getProviderTransactions.query({
      provider: "enablebanking",
      accountId: "account-1",
      accountType: "depository",
      latest: false,
    });

    expect(captured[0]?.headers.get("x-internal-key")).toBe(
      "test-internal-key",
    );
  });

  test("treats only the bank history fetch as slow", () => {
    expect([...SLOW_PROCEDURES]).toEqual(["banking.getProviderTransactions"]);
  });
});
