import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { decrypt } from "@midday/encryption";
import { createCallerFactory } from "../../trpc/init";
import { appsRouter } from "../../trpc/routers/apps";
import { createTestContext } from "../helpers/test-context";
import { mocks } from "../setup";

// Connecting Yuki encrypts the key before it is stored.
process.env.MIDDAY_ENCRYPTION_KEY ??= "ab".repeat(32);

const createCaller = createCallerFactory(appsRouter);

describe("tRPC: apps.get", () => {
  beforeEach(() => {
    mocks.getApps.mockReset();
    mocks.getApps.mockImplementation(() => Promise.resolve([]));
  });

  test("returns apps for team", async () => {
    const caller = createCaller(createTestContext());

    expect(await caller.get()).toEqual([]);
    expect(mocks.getApps).toHaveBeenCalledWith(
      expect.anything(),
      "test-team-id",
    );
  });

  test("returns integrations when query returns rows", async () => {
    mocks.getApps.mockImplementation(() =>
      Promise.resolve([{ app_id: "slack", settings: null, config: null }]),
    );

    const caller = createCaller(createTestContext());

    expect(await caller.get()).toEqual([
      { app_id: "slack", settings: null, config: null },
    ]);
  });

  test("never hands the dashboard Yuki's key, not even encrypted", async () => {
    mocks.getApps.mockImplementation(() =>
      Promise.resolve([
        {
          app_id: "yuki",
          settings: null,
          config: {
            encryptedAccessKey: "ciphertext",
            region: "be",
            administrationId: "11111111-1111-1111-1111-111111111111",
            administrationName: "Acme BV",
          },
        },
      ]),
    );

    const caller = createCaller(createTestContext());

    expect(await caller.get()).toEqual([
      {
        app_id: "yuki",
        settings: null,
        config: {
          region: "be",
          administrationId: "11111111-1111-1111-1111-111111111111",
          administrationName: "Acme BV",
        },
      },
    ]);
  });
});

// --- Yuki -------------------------------------------------------------------

const KEY = "5e1f0c9a-0000-4000-8000-00000000abcd";
const ADMIN = "11111111-1111-1111-1111-111111111111";

/** Yuki's side: accepts KEY only, on the Belgian host, with one administration. */
async function fakeYuki(url: string | URL | Request, init?: RequestInit) {
  const operation = String(
    (init?.headers as Record<string, string>).SOAPAction,
  ).replace(/^"http:\/\/www\.theyukicompany\.com\/|"$/g, "");
  const body = String(init?.body);

  const envelope = (inner: string, status = 200) =>
    new Response(
      `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${inner}</soap:Body></soap:Envelope>`,
      { status },
    );
  const fault = (message: string) =>
    envelope(
      `<soap:Fault><faultstring>${message}</faultstring></soap:Fault>`,
      500,
    );
  const result = (value: string) =>
    envelope(
      `<${operation}Response xmlns="http://www.theyukicompany.com/"><${operation}Result>${value}</${operation}Result></${operation}Response>`,
    );

  switch (operation) {
    case "Authenticate":
      return body.includes(`<accessKey>${KEY}</accessKey>`)
        ? result("session-1")
        : fault("Invalid access key");
    case "Administrations":
      return result(
        `<Administrations><Administration ID="${ADMIN}"><Name>Acme BV</Name><VATNumber>BE0123456789</VATNumber></Administration></Administrations>`,
      );
    case "DocumentFolders":
      return String(url).startsWith("https://api.yukiworks.be/")
        ? result("<DocumentFolders />")
        : fault("Domain has no active database");
    default:
      return fault(`unexpected ${operation}`);
  }
}

describe("tRPC: apps.verifyYuki", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      fakeYuki as typeof fetch,
    );
    mocks.createApp.mockClear();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test("names the administration the key reads, and saves nothing yet", async () => {
    const caller = createCaller(createTestContext());

    const answer = await caller.verifyYuki({ accessKey: KEY, region: "be" });

    expect(answer).toEqual({
      administrations: [
        { id: ADMIN, name: "Acme BV", vatNumber: "BE0123456789" },
      ],
    });
    expect(mocks.createApp).not.toHaveBeenCalled();
  });

  test("tells the user when Yuki refuses the key", async () => {
    const caller = createCaller(createTestContext());

    await expect(
      caller.verifyYuki({ accessKey: "not-the-key", region: "be" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message:
        "Yuki did not accept this access key. Copy it again from Settings > Web services in Yuki.",
    });
  });

  test("tells the user when the region is wrong", async () => {
    const caller = createCaller(createTestContext());

    await expect(
      caller.verifyYuki({ accessKey: KEY, region: "nl" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("tRPC: apps.connectYuki", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      fakeYuki as typeof fetch,
    );
    mocks.createApp.mockClear();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test("stores the connection on the caller's team, with the key encrypted", async () => {
    const caller = createCaller(createTestContext({ userId: "user-a" }));

    const answer = await caller.connectYuki({
      accessKey: KEY,
      region: "be",
      administrationId: ADMIN,
    });

    expect(answer).toEqual({ administrationName: "Acme BV", region: "be" });
    expect(mocks.createApp).toHaveBeenCalledTimes(1);

    const [, saved] = mocks.createApp.mock.calls[0] as [
      unknown,
      {
        teamId: string;
        createdBy: string;
        appId: string;
        config: { encryptedAccessKey: string };
      },
    ];
    expect(saved).toMatchObject({
      teamId: "test-team-id",
      createdBy: "user-a",
      appId: "yuki",
    });
    expect(JSON.stringify(saved)).not.toContain(KEY);
    expect(decrypt(saved.config.encryptedAccessKey)).toBe(KEY);
  });

  test("saves nothing when Yuki refuses the key", async () => {
    const caller = createCaller(createTestContext());

    await expect(
      caller.connectYuki({
        accessKey: "not-the-key",
        region: "be",
        administrationId: ADMIN,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(mocks.createApp).not.toHaveBeenCalled();
  });
});
