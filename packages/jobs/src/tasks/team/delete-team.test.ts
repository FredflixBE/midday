import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { DeleteTeamPayload as Payload } from "@jobs/schemas/teams";

// Everything the cleanup reaches outside this process is faked below: the
// Trigger.dev schedule API, Supabase Storage, Google's token endpoint, the
// banking API and the two database lookups. The job itself, the inbox
// connector and the storage walk all run for real.

process.env.MIDDAY_ENCRYPTION_KEY ??= "ab".repeat(32);
process.env.GMAIL_CLIENT_ID ??= "test-gmail-client";
process.env.GMAIL_CLIENT_SECRET ??= "test-gmail-secret";
process.env.OUTLOOK_CLIENT_ID ??= "test-outlook-client";
process.env.OUTLOOK_CLIENT_SECRET ??= "test-outlook-secret";
process.env.OUTLOOK_REDIRECT_URI ??= "https://midday.test/outlook";

const TEAM_ID = "5f0c3a52-8f4e-4d7b-9c1a-2b6e8d4f7a10";
const OTHER_TEAM_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const GMAIL_ACCOUNT_ID = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const OUTLOOK_ACCOUNT_ID = "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a";
const USER_ID = "3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b";

// --- Trigger.dev schedules --------------------------------------------------

type Schedule = { id: string; task: string; externalId?: string };

let scheduleStore: Schedule[] = [];

const sdk = await import("@trigger.dev/sdk");

const fakeSchedules = {
  ...sdk.schedules,
  // Two per page, so that a team's schedules are spread across pages.
  list: async (options?: { page?: number; perPage?: number }) => {
    const page = options?.page ?? 1;
    const perPage = Math.min(options?.perPage ?? 2, 2);
    return {
      data: scheduleStore.slice((page - 1) * perPage, page * perPage),
      pagination: {
        currentPage: page,
        totalPages: Math.max(1, Math.ceil(scheduleStore.length / perPage)),
        count: scheduleStore.length,
      },
    };
  },
  del: async (id: string) => {
    const index = scheduleStore.findIndex((schedule) => schedule.id === id);
    if (index === -1) {
      throw new sdk.NotFoundError(404, undefined, "Schedule not found", {});
    }
    scheduleStore.splice(index, 1);
    return { id };
  },
};

mock.module("@trigger.dev/sdk", () => ({ ...sdk, schedules: fakeSchedules }));

// --- Supabase Storage ---------------------------------------------------------

let bucketStore: Record<string, Set<string>> = {};
let storageError: Error | null = null;

function fakeBucket(bucket: string) {
  const files = () => bucketStore[bucket] ?? new Set<string>();

  return {
    // One level at a time, sub-folders as entries without an id — the shape
    // Storage returns.
    list: async (
      folder: string,
      options?: { limit?: number; offset?: number },
    ) => {
      if (storageError) return { data: null, error: storageError };

      const entries = new Map<string, boolean>();
      for (const path of files()) {
        if (!path.startsWith(`${folder}/`)) continue;
        const [name, ...rest] = path.slice(folder.length + 1).split("/");
        if (!name) continue;
        entries.set(name, entries.get(name) === true || rest.length === 0);
      }
      const offset = options?.offset ?? 0;
      const limit = options?.limit ?? 100;
      const data = [...entries.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(offset, offset + limit)
        .map(([name, isFile]) => ({ name, id: isFile ? `id:${name}` : null }));
      return { data, error: null };
    },
    remove: async (paths: string[]) => {
      for (const path of paths) files().delete(path);
      return { data: paths.map((name) => ({ name })), error: null };
    },
  };
}

mock.module("@midday/supabase/job", () => ({
  createClient: () => ({ storage: { from: fakeBucket } }),
}));

// --- Google ---------------------------------------------------------------

let revokedTokens: string[] = [];
let googleRejects: Record<string, unknown> = {};

const gmailModule = await import("@googleapis/gmail");

class FakeOAuth2 {
  async revokeToken(token: string) {
    if (token in googleRejects) throw googleRejects[token];
    revokedTokens.push(token);
    return { data: {} };
  }
}

mock.module("@googleapis/gmail", () => ({
  ...gmailModule,
  auth: { ...gmailModule.auth, OAuth2: FakeOAuth2 },
}));

// --- Banking API ------------------------------------------------------------

let providerDeletes: string[] = [];

mock.module("@midday/trpc", () => ({
  trpc: {
    banking: {
      deleteConnection: {
        mutate: async (input: { id: string }) => {
          providerDeletes.push(input.id);
        },
      },
    },
  },
}));

// --- Database -------------------------------------------------------------

let teamStillExists = false;
let connectedAddresses = new Set<string>();

const queries = await import("@midday/db/queries");

mock.module("@jobs/init", () => ({ getDb: () => ({}) }));
mock.module("@midday/db/queries", () => ({
  ...queries,
  getTeamById: async (_db: unknown, id: string) =>
    teamStillExists ? { id } : undefined,
  isInboxAddressConnected: async (_db: unknown, email: string) =>
    connectedAddresses.has(email),
}));

const { encrypt } = await import("@midday/encryption");
const { DeleteTeamProcessor } = await import("./delete-team");

function gmailAccount(): Payload["inboxAccounts"][number] {
  return {
    id: GMAIL_ACCOUNT_ID,
    provider: "gmail",
    email: "finance@example.com",
    refreshToken: encrypt("gmail-refresh-token"),
  };
}

function payload(overrides: Partial<Payload> = {}): Payload {
  return {
    teamId: TEAM_ID,
    connections: [],
    inboxAccounts: [],
    ...overrides,
  };
}

function runCleanup(data: Payload) {
  return new DeleteTeamProcessor().process({
    data,
    id: "run_test",
    name: "delete-team",
    attemptsMade: 0,
    opts: { attempts: 3 },
    updateProgress: async () => {},
  });
}

beforeEach(() => {
  scheduleStore = [];
  bucketStore = {};
  storageError = null;
  revokedTokens = [];
  googleRejects = {};
  providerDeletes = [];
  teamStillExists = false;
  connectedAddresses = new Set();
});

describe("delete-team", () => {
  test("removes the schedules of the team and of its inbox accounts, and no other", async () => {
    scheduleStore = [
      {
        id: "sched_other_bank",
        task: "bank-sync-scheduler",
        externalId: OTHER_TEAM_ID,
      },
      { id: "sched_bank", task: "bank-sync-scheduler", externalId: TEAM_ID },
      { id: "sched_cron", task: "ensure-bank-schedulers" },
      {
        id: "sched_gmail",
        task: "inbox-sync-scheduler",
        externalId: GMAIL_ACCOUNT_ID,
      },
      {
        id: "sched_other_inbox",
        task: "inbox-sync-scheduler",
        externalId: "someone-else",
      },
    ];

    await runCleanup(
      payload({
        inboxAccounts: [gmailAccount()],
      }),
    );

    expect(scheduleStore.map((schedule) => schedule.id)).toEqual([
      "sched_other_bank",
      "sched_cron",
      "sched_other_inbox",
    ]);
  });

  test("removes the team's files from the vault and avatars buckets, however deeply nested, and no one else's", async () => {
    bucketStore = {
      vault: new Set([
        `${TEAM_ID}/inbox/receipt.pdf`,
        `${TEAM_ID}/transactions/2026/09/invoice.pdf`,
        `${TEAM_ID}/insights/weekly.mp3`,
        `${TEAM_ID}/.emptyFolderPlaceholder`,
        `${OTHER_TEAM_ID}/inbox/receipt.pdf`,
      ]),
      avatars: new Set([
        `${TEAM_ID}/logo.png`,
        `${TEAM_ID}/invoice/logo.png`,
        `${USER_ID}/me.png`,
        `${OTHER_TEAM_ID}/logo.png`,
      ]),
    };

    await runCleanup(payload());

    expect([...(bucketStore.vault ?? [])]).toEqual([
      `${OTHER_TEAM_ID}/inbox/receipt.pdf`,
    ]);
    expect([...(bucketStore.avatars ?? [])]).toEqual([
      `${USER_ID}/me.png`,
      `${OTHER_TEAM_ID}/logo.png`,
    ]);
  });

  test("touches nothing while the team still exists, and fails so that it runs again", async () => {
    teamStillExists = true;
    scheduleStore = [
      { id: "sched_bank", task: "bank-sync-scheduler", externalId: TEAM_ID },
    ];
    bucketStore = { vault: new Set([`${TEAM_ID}/inbox/receipt.pdf`]) };

    await expect(
      runCleanup(
        payload({
          connections: [
            { referenceId: "req_1", provider: "gocardless", accessToken: null },
          ],
          inboxAccounts: [gmailAccount()],
        }),
      ),
    ).rejects.toThrow();

    expect(scheduleStore).toHaveLength(1);
    expect([...(bucketStore.vault ?? [])]).toEqual([
      `${TEAM_ID}/inbox/receipt.pdf`,
    ]);
    expect(providerDeletes).toEqual([]);
    expect(revokedTokens).toEqual([]);
  });

  test("revokes the app's access to each Gmail inbox the team connected", async () => {
    await runCleanup(
      payload({
        inboxAccounts: [gmailAccount()],
      }),
    );

    expect(revokedTokens).toEqual(["gmail-refresh-token"]);
  });

  test("leaves Gmail access alone when the address has been connected again", async () => {
    // Google revokes every grant the address gave the app, so revoking here
    // would cut off the team that connected it since.
    connectedAddresses = new Set(["finance@example.com"]);

    await runCleanup(
      payload({
        inboxAccounts: [gmailAccount()],
      }),
    );

    expect(revokedTokens).toEqual([]);
  });

  test("treats a token Google no longer recognises as already revoked", async () => {
    googleRejects = {
      "gmail-refresh-token": Object.assign(new Error("invalid_token"), {
        response: { status: 400, data: { error: "invalid_token" } },
      }),
    };

    await expect(
      runCleanup(
        payload({
          inboxAccounts: [gmailAccount()],
        }),
      ),
    ).resolves.toBeDefined();
  });

  test("still clears an Outlook inbox's schedule, which is all Microsoft allows", async () => {
    scheduleStore = [
      {
        id: "sched_outlook",
        task: "inbox-sync-scheduler",
        externalId: OUTLOOK_ACCOUNT_ID,
      },
    ];

    await runCleanup(
      payload({
        inboxAccounts: [
          {
            id: OUTLOOK_ACCOUNT_ID,
            provider: "outlook",
            email: "books@example.com",
            refreshToken: encrypt("outlook-refresh-token"),
          },
        ],
      }),
    );

    expect(scheduleStore).toEqual([]);
    expect(revokedTokens).toEqual([]);
  });

  test("deletes the team's bank connections at the provider", async () => {
    await runCleanup(
      payload({
        connections: [
          { referenceId: "req_1", provider: "gocardless", accessToken: null },
          {
            referenceId: "sess_2",
            provider: "enablebanking",
            accessToken: null,
          },
        ],
      }),
    );

    expect(providerDeletes).toEqual(["req_1", "sess_2"]);
  });

  test("a step that fails does not stop the others, and the run fails so that it is retried", async () => {
    scheduleStore = [
      { id: "sched_bank", task: "bank-sync-scheduler", externalId: TEAM_ID },
    ];
    storageError = new Error("Storage is unavailable");

    await expect(
      runCleanup(
        payload({
          connections: [
            { referenceId: "req_1", provider: "gocardless", accessToken: null },
          ],
          inboxAccounts: [gmailAccount()],
        }),
      ),
    ).rejects.toThrow("Storage is unavailable");

    expect(scheduleStore).toEqual([]);
    expect(revokedTokens).toEqual(["gmail-refresh-token"]);
    expect(providerDeletes).toEqual(["req_1"]);
  });
});
