import { describe, expect, test } from "bun:test";
import { inboxFileName, syncMailbox } from "./inbox-sync";

const STARTED_AT = new Date("2026-09-11T12:00:00Z");

function ids(count: number) {
  return Array.from({ length: count }, (_, i) => `msg${i}`);
}

/** A mailbox holding `messageIds`, and a record of how the sync read it. */
function mailbox(messageIds: string[], options: { failOnBatch?: number } = {}) {
  const listedSince: Date[] = [];
  const batches: string[][] = [];

  return {
    listedSince,
    batches,
    listMessageIds: async (since: Date) => {
      listedSince.push(since);
      return messageIds;
    },
    // Each message carries one attachment.
    syncBatch: async (batch: string[]) => {
      batches.push(batch);
      if (batches.length === options.failOnBatch) {
        throw new Error("batch run failed");
      }
      return batch.length;
    },
  };
}

describe("a backfill", () => {
  test("reads every message since the chosen date, twenty at a time", async () => {
    const mail = mailbox(ids(45));

    const result = await syncMailbox({
      lastAccessed: "2026-09-11T06:00:00.000Z",
      since: "2025-01-01",
      fullSync: false,
      startedAt: STARTED_AT,
      listMessageIds: mail.listMessageIds,
      syncBatch: mail.syncBatch,
    });

    expect(mail.listedSince).toEqual([new Date("2025-01-01T00:00:00Z")]);
    expect(mail.batches.map((batch) => batch.length)).toEqual([20, 20, 5]);
    expect(mail.batches.flat()).toEqual(ids(45));
    expect(result).toMatchObject({
      messages: 45,
      attachmentsProcessed: 45,
      lastAccessed: "2026-09-11T12:00:00.000Z",
    });
  });
});

describe("the watermark", () => {
  test("stays where it was when a batch fails, and the sync stops there", async () => {
    const mail = mailbox(ids(45), { failOnBatch: 2 });

    const result = await syncMailbox({
      lastAccessed: "2026-09-11T06:00:00.000Z",
      fullSync: false,
      startedAt: STARTED_AT,
      listMessageIds: mail.listMessageIds,
      syncBatch: mail.syncBatch,
    });

    expect(mail.batches).toHaveLength(2);
    expect(result).toMatchObject({
      messages: 45,
      attachmentsProcessed: 20,
      lastAccessed: null,
    });
    expect(result.error).toBeInstanceOf(Error);
  });

  test("stays where it was after a backfill that began later than it", async () => {
    // Moving it would skip January to May, which nothing has read.
    const mail = mailbox(ids(3));

    const result = await syncMailbox({
      lastAccessed: "2026-01-01T00:00:00.000Z",
      since: "2026-06-01",
      fullSync: false,
      startedAt: STARTED_AT,
      listMessageIds: mail.listMessageIds,
      syncBatch: mail.syncBatch,
    });

    expect(mail.batches.flat()).toEqual(ids(3));
    expect(result.lastAccessed).toBeNull();
  });

  test("moves to when the sync began once a window with no mail is read", async () => {
    const mail = mailbox([]);

    const result = await syncMailbox({
      lastAccessed: "2026-09-11T06:00:00.000Z",
      fullSync: false,
      startedAt: STARTED_AT,
      listMessageIds: mail.listMessageIds,
      syncBatch: mail.syncBatch,
    });

    expect(mail.batches).toEqual([]);
    expect(result.lastAccessed).toBe("2026-09-11T12:00:00.000Z");
  });
});

describe("where a sync starts reading", () => {
  async function startOf(options: {
    lastAccessed: string | null;
    fullSync: boolean;
  }) {
    const mail = mailbox([]);
    await syncMailbox({
      ...options,
      startedAt: STARTED_AT,
      listMessageIds: mail.listMessageIds,
      syncBatch: mail.syncBatch,
    });
    return mail.listedSince[0]?.toISOString();
  }

  test("a scheduled sync starts a day before the watermark", async () => {
    expect(
      await startOf({
        lastAccessed: "2026-09-11T06:00:00.000Z",
        fullSync: false,
      }),
    ).toBe("2026-09-10T06:00:00.000Z");
  });

  test("a manual sync looks back thirty days", async () => {
    expect(
      await startOf({
        lastAccessed: "2026-09-11T06:00:00.000Z",
        fullSync: true,
      }),
    ).toBe("2026-08-12T12:00:00.000Z");
  });

  test("a manual sync reaches further back when the watermark is older", async () => {
    expect(
      await startOf({
        lastAccessed: "2026-06-01T08:00:00.000Z",
        fullSync: true,
      }),
    ).toBe("2026-05-31T08:00:00.000Z");
  });

  test("an account that has never synced looks back thirty days", async () => {
    expect(await startOf({ lastAccessed: null, fullSync: false })).toBe(
      "2026-08-12T12:00:00.000Z",
    );
  });
});

describe("the name a synced attachment is stored under", () => {
  test("differs for two emails that attach a file of the same name", () => {
    const january = inboxFileName({
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      referenceId:
        "407b44dcb584cff4aaa71a961d5929ad48725802888d30f59b9def9c0f6d672b",
    });
    const february = inboxFileName({
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      referenceId:
        "a7c64b1e7cdbee72bc2e18c878ef94c7e06d82c2abd7d26eb4a8cbd3af3b5761",
    });

    expect(january).toBe("invoice_407b44dc.pdf");
    expect(february).toBe("invoice_a7c64b1e.pdf");
  });

  test("gains its extension when the email left it off", () => {
    expect(
      inboxFileName({
        filename: "factuur",
        mimeType: "application/pdf",
        referenceId:
          "407b44dcb584cff4aaa71a961d5929ad48725802888d30f59b9def9c0f6d672b",
      }),
    ).toBe("factuur_407b44dc.pdf");
  });
});
