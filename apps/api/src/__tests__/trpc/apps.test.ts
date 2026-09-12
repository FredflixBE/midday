import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as queries from "@midday/db/queries";
import { decrypt, encrypt } from "@midday/encryption";
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

// Every route that hands a row back, not only `get`.
describe("tRPC: apps routes that return the stored row", () => {
  const storedYukiRow = {
    id: "row-1",
    teamId: "test-team-id",
    appId: "yuki",
    settings: [],
    config: {
      encryptedAccessKey: "ciphertext",
      region: "be",
      administrationId: "11111111-1111-1111-1111-111111111111",
      administrationName: "Acme BV",
    },
  };

  const answers = {
    disconnect: (caller: ReturnType<typeof createCaller>) =>
      caller.disconnect({ appId: "yuki" }),
    update: (caller: ReturnType<typeof createCaller>) =>
      caller.update({ appId: "yuki", option: { id: "x", value: true } }),
    updateSettings: (caller: ReturnType<typeof createCaller>) =>
      caller.updateSettings({ appId: "yuki", settings: [] }),
  };
  const queryFor = {
    disconnect: queries.disconnectApp,
    update: queries.updateAppSettings,
    updateSettings: queries.updateAppSettingsBulk,
  } as unknown as Record<keyof typeof answers, ReturnType<typeof spyOn>>;

  for (const route of Object.keys(answers) as (keyof typeof answers)[]) {
    test(`${route} does not hand back Yuki's key`, async () => {
      queryFor[route].mockImplementationOnce(() =>
        Promise.resolve(storedYukiRow),
      );

      const answer = await answers[route](createCaller(createTestContext()));

      expect(JSON.stringify(answer)).not.toContain("encryptedAccessKey");
      expect(answer).toMatchObject({
        appId: "yuki",
        config: { administrationName: "Acme BV" },
      });
    });
  }
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
    case "GetGLAccountScheme":
      // Two credit-card accounts (sub-type 52): the unnamed one every Belgian
      // scheme ships, and a real card.
      return result(
        [
          "<GlAccount>",
          "<code>434000</code><subtype>52</subtype><isEnabled>true</isEnabled>",
          "<descripton>(Reserved for credit card)</descripton>",
          "</GlAccount>",
          "<GlAccount>",
          "<code>434001</code><subtype>52</subtype><isEnabled>true</isEnabled>",
          "<descripton>Example Card Holder</descripton>",
          "</GlAccount>",
          "<GlAccount>",
          "<code>440000</code><subtype>2</subtype><isEnabled>true</isEnabled>",
          "<descripton>Leveranciers</descripton>",
          "</GlAccount>",
        ].join(""),
      );
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

// --- The card read out of the books (FF-1517) --------------------------------

/** The team's stored Yuki connection, as `yukiClientForTeam` reads it. */
const connectedYukiApp = {
  appId: "yuki",
  config: {
    encryptedAccessKey: encrypt(KEY),
    region: "be" as const,
    administrationId: ADMIN,
    administrationName: "Acme BV",
  },
};

describe("tRPC: apps.yukiCardAccounts", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      fakeYuki as typeof fetch,
    );
    mocks.getAppByAppId.mockImplementation(() =>
      Promise.resolve(connectedYukiApp),
    );
    mocks.getYukiCardConnections.mockImplementation(() => Promise.resolve([]));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    mocks.getAppByAppId.mockReset();
    mocks.getYukiCardConnections.mockReset();
  });

  test("offers the real cards, and never the scheme's unnamed placeholder", async () => {
    const caller = createCaller(createTestContext());

    expect(await caller.yukiCardAccounts()).toEqual({
      accounts: [
        { glAccountCode: "434001", name: "Example Card Holder", linked: false },
      ],
    });
  });

  test("marks a card that is already linked, rather than offering it again", async () => {
    mocks.getYukiCardConnections.mockImplementation(() =>
      Promise.resolve([{ glAccountCode: "434001" }]),
    );

    const caller = createCaller(createTestContext());

    expect((await caller.yukiCardAccounts()).accounts[0]?.linked).toBe(true);
  });

  test("shows a team without the app no trace of the integration", async () => {
    // The connect flow asks this to decide whether to offer the option at all,
    // so an error here would be a Yuki-shaped hole in a stranger's screen.
    mocks.getAppByAppId.mockImplementation(() => Promise.resolve(null));

    const caller = createCaller(createTestContext());

    expect(await caller.yukiCardAccounts()).toEqual({ accounts: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("tRPC: apps.connectYukiCard", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      fakeYuki as typeof fetch,
    );
    mocks.getAppByAppId.mockImplementation(() =>
      Promise.resolve(connectedYukiApp),
    );
    mocks.createYukiCardConnection.mockImplementation(() =>
      Promise.resolve({
        connectionId: "connection-1",
        bankAccountId: "account-1",
      }),
    );
    mocks.triggerTask.mockClear();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    mocks.getAppByAppId.mockReset();
    mocks.createYukiCardConnection.mockReset();
  });

  test("links the card under a synthetic institution id, and syncs it", async () => {
    const caller = createCaller(createTestContext({ userId: "user-a" }));

    expect(await caller.connectYukiCard({ glAccountCode: "434001" })).toEqual({
      connectionId: "connection-1",
      bankAccountId: "account-1",
      // No row in the shared `institutions` table: it is global, so an entry
      // there would put Yuki in every other team's bank search.
      institutionId: "yuki:434001",
      name: "Example Card Holder",
    });

    expect(mocks.createYukiCardConnection).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        teamId: "test-team-id",
        userId: "user-a",
        glAccountCode: "434001",
        cardName: "Example Card Holder",
        currency: "EUR",
      }),
    );
    expect(mocks.triggerTask).toHaveBeenCalledWith("yuki-sync-card-charges", {
      teamId: "test-team-id",
      connectionId: "connection-1",
    });
  });

  test("refuses an account that is not a card in this administration", async () => {
    const caller = createCaller(createTestContext());

    await expect(
      caller.connectYukiCard({ glAccountCode: "440000" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(mocks.createYukiCardConnection).not.toHaveBeenCalled();
  });

  test("refuses the same card twice rather than making a second connection", async () => {
    mocks.createYukiCardConnection.mockImplementation(() =>
      Promise.resolve(null),
    );

    const caller = createCaller(createTestContext());

    await expect(
      caller.connectYukiCard({ glAccountCode: "434001" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(mocks.triggerTask).not.toHaveBeenCalled();
  });

  test("asks a team with no Yuki to connect it first", async () => {
    mocks.getAppByAppId.mockImplementation(() => Promise.resolve(null));

    const caller = createCaller(createTestContext());

    await expect(
      caller.connectYukiCard({ glAccountCode: "434001" }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});
