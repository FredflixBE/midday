import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// The other probes' packages validate their environment and open a database
// pool when imported; the Resend probe needs neither.
mock.module("@midday/banking", () => ({
  isGoCardlessConfigured: () => false,
  Provider: class {},
}));
mock.module("@midday/db/utils/health", () => ({ checkHealth: async () => {} }));

let resendProbe: typeof import("./probes.js").resendProbe;
beforeAll(async () => {
  ({ resendProbe } = await import("./probes.js"));
});

/**
 * Resend's answers, as its API reference lists them and as `GET /domains`
 * returns them. The body is `{ statusCode, message, name }`.
 */
const answer = (status: number, name?: string, message = "") =>
  name
    ? Response.json({ statusCode: status, message, name }, { status })
    : Response.json({ data: [] }, { status });

const realFetch = globalThis.fetch;
let respond: () => Response;
const fetchMock = mock(async (_url: string | URL | Request) => respond());

describe("resendProbe", () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test";
    fetchMock.mockClear();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
  });

  const probe = () => resendProbe().probe();

  test("a full-access key that lists the domains is healthy", async () => {
    respond = () => answer(200);
    expect(await probe()).toBe(true);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://api.resend.com/domains",
    );
  });

  test("a sending-only key, refused the listing for its scope, is healthy", async () => {
    respond = () =>
      answer(
        401,
        "restricted_api_key",
        "This API key is restricted to only send emails",
      );
    expect(await probe()).toBe(true);
  });

  test("a key Resend does not know is unhealthy", async () => {
    respond = () => answer(400, "validation_error", "API key is invalid");
    expect(await probe()).toBe(false);
  });

  test("a key that is no longer active is unhealthy, though Resend names it the same", async () => {
    respond = () => answer(403, "restricted_api_key", "API key is not active");
    expect(await probe()).toBe(false);
  });

  test("any other 401 is unhealthy", async () => {
    respond = () => answer(401, "missing_api_key", "Missing API Key");
    expect(await probe()).toBe(false);
  });

  test("a 401 whose body is not Resend's error is unhealthy", async () => {
    respond = () => new Response("Unauthorized", { status: 401 });
    expect(await probe()).toBe(false);
  });

  test("Resend being down is unhealthy", async () => {
    respond = () => answer(503, "service_unavailable");
    expect(await probe()).toBe(false);
  });

  test("no key is unhealthy, and nothing is asked", async () => {
    delete process.env.RESEND_API_KEY;
    expect(await probe()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
