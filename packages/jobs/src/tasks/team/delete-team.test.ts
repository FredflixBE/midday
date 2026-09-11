import { beforeEach, describe, expect, mock, test } from "bun:test";

// Everything the cleanup reaches outside this process is faked below: the
// Trigger.dev schedule API, Supabase Storage, Google's token endpoint, the
// banking API and the two database lookups. The job itself, the inbox
// connector and the storage walk all run for real.

process.env.MIDDAY_ENCRYPTION_KEY = "ab".repeat(32);
process.env.GMAIL_CLIENT_ID ??= "test-gmail-client";
process.env.GMAIL_CLIENT_SECRET ??= "test-gmail-secret";

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

function fakeBucket(bucket: string) {
  const files = () => bucketStore[bucket] ?? new Set<string>();

  return {
    // One level at a time, sub-folders as entries without an id — the shape
    // Storage returns.
    list: async (
      folder: string,
      options?: { limit?: number; offset?: number },
    ) => {
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

type Payload = Parameters<DeleteTeamProcessor["process"]>[0]["data"];

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
  revokedTokens = [];
  googleRejects = {};
  providerDeletes = [];
  teamStillExists = false;
  connectedAddresses = new Set();
});

describe("delete-team", () => {
  test("removes the schedules of the team and of its inbox accounts, and no other", async () => {
    scheduleStore = [
      { id: "sched_other_bank", task: "bank-sync-scheduler", externalId: OTHER_TEAM_ID },
      { id: "sched_bank", task: "bank-sync-scheduler", externalId: TEAM_ID },
      { id: "sched_cron", task: "ensure-bank-schedulers" },
      { id: "sched_gmail", task: "inbox-sync-scheduler", externalId: GMAIL_ACCOUNT_ID },
      { id: "sched_other_inbox", task: "inbox-sync-scheduler", externalId: "someone-else" },
    ];

    await runCleanup(
      payload({
        inboxAccounts: [
          {
            id: GMAIL_ACCOUNT_ID,
            provider: "gmail",
            email: "finance@example.com",
            refreshToken: encrypt("gmail-refresh-token"),
          },
        ],
      }),
    );

    expect(scheduleStore.map((schedule) => schedule.id)).toEqual([
      "sched_other_bank",
      "sched_cron",
      "sched_other_inbox",
    ]);
  });
});
