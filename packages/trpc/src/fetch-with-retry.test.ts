import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createFetchWithRetry } from "./fetch-with-retry";

const originalFetch = globalThis.fetch;

// A fetch that never answers on its own, so only the timeout can end it.
function hangingFetch() {
  return mock((_input: unknown, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(init.signal?.reason),
      );
    });
  });
}

describe("createFetchWithRetry", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("gives up after the timeout, and retries a timeout once by default", async () => {
    const fetchMock = hangingFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const fetchWithRetry = createFetchWithRetry({ timeoutMs: 20 });

    const error = await fetchWithRetry("http://api.test/trpc").catch(
      (err) => err,
    );

    expect(error?.name).toBe("TimeoutError");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("does not repeat a request that timed out when timeouts are not retried", async () => {
    const fetchMock = hangingFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const fetchWithRetry = createFetchWithRetry({
      timeoutMs: 20,
      retryTimeouts: false,
    });

    const error = await fetchWithRetry("http://api.test/trpc").catch(
      (err) => err,
    );

    expect(error?.name).toBe("TimeoutError");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("still retries a refused connection when timeouts are not retried", async () => {
    let calls = 0;
    const fetchMock = mock(async () => {
      calls++;
      if (calls === 1) {
        throw Object.assign(new Error("connect failed"), {
          code: "ECONNREFUSED",
        });
      }
      return new Response("ok");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const fetchWithRetry = createFetchWithRetry({
      timeoutMs: 1_000,
      retryTimeouts: false,
    });

    const response = await fetchWithRetry("http://api.test/trpc");

    expect(await response.text()).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("does not retry an error that is not about the connection", async () => {
    const fetchMock = mock(async () => {
      throw new TypeError("invalid url");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const fetchWithRetry = createFetchWithRetry({ timeoutMs: 1_000 });

    const error = await fetchWithRetry("http://api.test/trpc").catch(
      (err) => err,
    );

    expect(error).toBeInstanceOf(TypeError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
