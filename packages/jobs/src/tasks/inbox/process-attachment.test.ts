import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ProcessAttachmentPayload } from "@jobs/schemas/inbox";
import * as queries from "@midday/db/queries";

// The file is never in the vault here: every case is a run that reaches for
// it and finds it gone. What differs is whether the inbox item was deleted
// (FF-1469) — a quiet ending — or is still there waiting for this run, which
// has to stay a failure so onFailure can mark it.

const TEAM_ID = "5f0c3a52-8f4e-4d7b-9c1a-2b6e8d4f7a10";
const INBOX_ID = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

let liveRow: { id: string; status: string; contentType: string } | undefined;
let wasDeleted = false;
let deletedCheckFails = false;
let created = 0;
let deletedChecks = 0;

mock.module("@jobs/init", () => ({ getDb: () => ({}) }));

mock.module("@midday/db/queries", () => ({
  ...queries,
  getInboxByFilePath: async () => liveRow,
  inboxFileWasDeleted: async () => {
    deletedChecks++;
    if (deletedCheckFails) throw new Error("connection terminated");
    return wasDeleted;
  },
  createInbox: async () => {
    created++;
    return {
      id: INBOX_ID,
      status: "processing",
      filePath: payload.filePath,
      contentType: payload.mimetype,
    };
  },
  getTeamById: async () => ({ id: TEAM_ID, name: "Fredflix" }),
}));

// What Storage answers for an object that is not there.
mock.module("@midday/supabase/job", () => ({
  createClient: () => ({
    storage: {
      from: () => ({
        download: async () => ({ data: null, error: new Error("404") }),
        createSignedUrl: async () => ({
          data: null,
          error: new Error("Object not found"),
        }),
      }),
    },
  }),
}));

// Never reached without a file; stubbed so their imports (a worker database
// pool among them) stay out of this process.
mock.module("../document/process-document", () => ({ processDocument: {} }));
mock.module("./batch-process-matching", () => ({ batchProcessMatching: {} }));

const { ProcessAttachmentProcessor } = await import("./process-attachment");
const { NonRetryableError } = await import("@jobs/utils/error-classification");

let payload: ProcessAttachmentPayload;

function run(mimetype = "application/pdf") {
  payload = {
    teamId: TEAM_ID,
    mimetype,
    size: 1024,
    filePath: [TEAM_ID, "inbox", "receipt_ab12cd.pdf"],
  } as ProcessAttachmentPayload;

  return new ProcessAttachmentProcessor().process({
    data: payload,
    name: "process-attachment",
    attemptsMade: 0,
    opts: {},
    updateProgress: async () => {},
  });
}

beforeEach(() => {
  liveRow = { id: INBOX_ID, status: "processing", contentType: "" };
  wasDeleted = false;
  deletedCheckFails = false;
  created = 0;
  deletedChecks = 0;
});

describe("process-attachment, when the file is gone", () => {
  test("ends quietly when the item was deleted while it was being read", async () => {
    wasDeleted = true;

    await expect(run()).resolves.toBeUndefined();
  });

  test("ends quietly when a photo's item was deleted before it was converted", async () => {
    wasDeleted = true;
    liveRow = { id: INBOX_ID, status: "processing", contentType: "image/heic" };

    await expect(run("image/heic")).resolves.toBeUndefined();
  });

  test("still fails when the item is there and only its file is missing", async () => {
    await expect(run()).rejects.toBeInstanceOf(NonRetryableError);
  });

  test("still fails with the missing file when the check cannot answer", async () => {
    deletedCheckFails = true;

    await expect(run()).rejects.toBeInstanceOf(NonRetryableError);
  });

  test("still fails for a photo whose item is there", async () => {
    liveRow = { id: INBOX_ID, status: "processing", contentType: "image/heic" };

    await expect(run("image/heic")).rejects.toBeInstanceOf(NonRetryableError);
  });
});

describe("process-attachment, when no live item holds the file", () => {
  test("does not bring back an item deleted before the run started", async () => {
    liveRow = undefined;
    wasDeleted = true;

    await expect(run()).resolves.toBeUndefined();
    expect(created).toBe(0);
  });

  test("creates the item for a file nobody has made one for yet", async () => {
    liveRow = undefined;

    // It goes on to the file, which is missing here — so it fails, but only
    // after making the row email sync relies on it for.
    await expect(run()).rejects.toBeInstanceOf(NonRetryableError);
    expect(created).toBe(1);
  });

  test("does not ask about deletion for an item that is still live", async () => {
    liveRow = { id: INBOX_ID, status: "processing", contentType: "" };
    wasDeleted = true;

    // Asked only once the file turns out missing, not up front.
    await run();
    expect(deletedChecks).toBe(1);
  });
});
