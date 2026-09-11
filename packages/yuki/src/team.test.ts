import { beforeEach, describe, expect, it, mock } from "bun:test";
import { decrypt } from "@midday/encryption";
import type { FetchLike } from "./client";
import { YUKI_NAMESPACE } from "./soap";

process.env.MIDDAY_ENCRYPTION_KEY ??= "ab".repeat(32);

// The apps table, as the two queries team.ts uses see it: one row per team
// and app, the same unique key the real table has.
type Row = {
  teamId: string;
  appId: string;
  createdBy: string;
  config: Record<string, unknown>;
};
let rows: Row[] = [];

mock.module("@midday/db/queries", () => ({
  createApp: async (_db: unknown, params: Row) => {
    rows = rows.filter(
      (r) => !(r.teamId === params.teamId && r.appId === params.appId),
    );
    rows.push(params);
    return params;
  },
  getAppByAppId: async (
    _db: unknown,
    params: { appId: string; teamId: string },
  ) =>
    rows.find((r) => r.teamId === params.teamId && r.appId === params.appId) ??
    null,
}));

const { connectYuki, yukiClientForTeam, YukiNotConnectedError } = await import(
  "./team"
);
const { YukiAccessError } = await import("./errors");

const db = {} as never;
const TEAM = "a0000000-0000-4000-8000-000000000001";
const SECOND_TEAM = "b0000000-0000-4000-8000-000000000002";
const USER = "c0000000-0000-4000-8000-000000000003";
const ADMIN = "11111111-1111-1111-1111-111111111111";
const KEY = "5e1f0c9a-0000-4000-8000-00000000abcd";

/** A Yuki that accepts KEY only, and sees one administration. */
function fakeYuki() {
  const requests: { operation: string; url: string; body: string }[] = [];

  const fetchImpl: FetchLike = async (url, init) => {
    const operation = String(
      (init.headers as Record<string, string>).SOAPAction,
    )
      .replace(/"/g, "")
      .slice(YUKI_NAMESPACE.length);
    const body = String(init.body);
    requests.push({ operation, url, body });

    const envelope = (inner: string) =>
      new Response(
        `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${inner}</soap:Body></soap:Envelope>`,
        { status: inner.includes("Fault") ? 500 : 200 },
      );
    const result = (value: string) =>
      envelope(
        `<${operation}Response xmlns="${YUKI_NAMESPACE}"><${operation}Result>${value}</${operation}Result></${operation}Response>`,
      );

    switch (operation) {
      case "Authenticate":
        return body.includes(`<accessKey>${KEY}</accessKey>`)
          ? result("session-1")
          : envelope(
              "<soap:Fault><faultstring>Invalid access key</faultstring></soap:Fault>",
            );
      case "Administrations":
        return result(
          `<Administrations><Administration ID="${ADMIN}"><Name>Acme BV</Name></Administration></Administrations>`,
        );
      default:
        return result("");
    }
  };

  return { fetchImpl, requests };
}

beforeEach(() => {
  rows = [];
});

describe("connecting Yuki to a team", () => {
  it("stores the key encrypted, with the administration the user confirmed", async () => {
    const yuki = fakeYuki();

    await connectYuki(
      db,
      {
        teamId: TEAM,
        userId: USER,
        accessKey: KEY,
        region: "be",
        administrationId: ADMIN,
      },
      { fetchImpl: yuki.fetchImpl },
    );

    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({ teamId: TEAM, appId: "yuki", createdBy: USER });
    expect(row?.config).toMatchObject({
      region: "be",
      administrationId: ADMIN,
      administrationName: "Acme BV",
    });
    expect(JSON.stringify(row?.config)).not.toContain(KEY);
    expect(decrypt(row?.config.encryptedAccessKey as string)).toBe(KEY);
  });

  it("answers with the administration, and never with the key", async () => {
    const yuki = fakeYuki();

    const answer = await connectYuki(
      db,
      {
        teamId: TEAM,
        userId: USER,
        accessKey: KEY,
        region: "be",
        administrationId: ADMIN,
      },
      { fetchImpl: yuki.fetchImpl },
    );

    expect(answer).toEqual({ administrationName: "Acme BV", region: "be" });
  });

  it("saves nothing when Yuki refuses the key", async () => {
    const yuki = fakeYuki();

    await expect(
      connectYuki(
        db,
        {
          teamId: TEAM,
          userId: USER,
          accessKey: "not-the-key",
          region: "be",
          administrationId: ADMIN,
        },
        { fetchImpl: yuki.fetchImpl },
      ),
    ).rejects.toBeInstanceOf(YukiAccessError);

    expect(rows).toEqual([]);
  });

  it("saves nothing when the chosen administration is not one the key can see", async () => {
    const yuki = fakeYuki();

    await expect(
      connectYuki(
        db,
        {
          teamId: TEAM,
          userId: USER,
          accessKey: KEY,
          region: "be",
          administrationId: "99999999-9999-9999-9999-999999999999",
        },
        { fetchImpl: yuki.fetchImpl },
      ),
    ).rejects.toMatchObject({ reason: "unknown_administration" });

    expect(rows).toEqual([]);
  });
});

describe("a client for a team", () => {
  it("is built from that team's own connection", async () => {
    const yuki = fakeYuki();
    await connectYuki(
      db,
      {
        teamId: TEAM,
        userId: USER,
        accessKey: KEY,
        region: "be",
        administrationId: ADMIN,
      },
      { fetchImpl: yuki.fetchImpl },
    );
    yuki.requests.length = 0;

    const client = await yukiClientForTeam(db, TEAM, {
      fetchImpl: yuki.fetchImpl,
    });
    await client.authenticate();

    expect(client.administrationId).toBe(ADMIN);
    expect(yuki.requests).toHaveLength(1);
    expect(yuki.requests[0]?.url).toStartWith("https://api.yukiworks.be/");
    expect(yuki.requests[0]?.body).toContain(`<accessKey>${KEY}</accessKey>`);
  });

  it("does not exist for a second team that has not connected Yuki", async () => {
    const yuki = fakeYuki();
    await connectYuki(
      db,
      {
        teamId: TEAM,
        userId: USER,
        accessKey: KEY,
        region: "be",
        administrationId: ADMIN,
      },
      { fetchImpl: yuki.fetchImpl },
    );
    yuki.requests.length = 0;

    const attempt = yukiClientForTeam(db, SECOND_TEAM, {
      fetchImpl: yuki.fetchImpl,
    });

    await expect(attempt).rejects.toBeInstanceOf(YukiNotConnectedError);
    await expect(attempt).rejects.toMatchObject({ teamId: SECOND_TEAM });
    expect(yuki.requests).toEqual([]);
  });
});
