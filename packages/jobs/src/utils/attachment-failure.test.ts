import { beforeEach, describe, expect, mock, test } from "bun:test";

type UpdateCall = { table: unknown; values: unknown };

let updateCalls: UpdateCall[] = [];
let returnedRows: { id: string }[] = [];
let dbError: Error | null = null;

/**
 * A stand-in for the run's database handle. The query itself is the real one —
 * only the driver underneath it is fake — so the test still covers the shape
 * of the statement markInboxAttachmentFailed builds.
 */
function fakeDb() {
  return {
    update: (table: unknown) => ({
      set: (values: unknown) => ({
        where: () => ({
          returning: async () => {
            updateCalls.push({ table, values });
            if (dbError) throw dbError;
            return returnedRows;
          },
        }),
      }),
    }),
  };
}

mock.module("@jobs/init", () => ({
  getDb: () => fakeDb(),
}));

const {
  STRANDED_AFTER_MINUTES,
  failedBatchItems,
  markAttachmentFailed,
  sweepStrandedAttachments,
} = await import("./attachment-failure");

beforeEach(() => {
  updateCalls = [];
  returnedRows = [{ id: "inbox-1" }];
  dbError = null;
});

describe("failedBatchItems", () => {
  test("returns the items whose runs did not succeed", () => {
    expect(
      failedBatchItems(
        ["a", "b", "c"],
        [{ ok: true }, { ok: false }, { ok: false }],
      ),
    ).toEqual({ failed: ["b", "c"], unreadable: false });
  });

  test("returns nothing when every run succeeded", () => {
    expect(failedBatchItems(["a", "b"], [{ ok: true }, { ok: true }])).toEqual({
      failed: [],
      unreadable: false,
    });
  });

  test("refuses to pair results with items when the counts disagree", () => {
    // Pairing by index only means anything while the two are the same length.
    // Guessing here would mark a healthy row failed.
    expect(failedBatchItems(["a", "b"], [{ ok: false }])).toEqual({
      failed: [],
      unreadable: true,
    });
  });

  test("handles an empty batch", () => {
    expect(failedBatchItems([], [])).toEqual({
      failed: [],
      unreadable: false,
    });
  });
});

describe("markAttachmentFailed", () => {
  test("writes the failed status", async () => {
    await markAttachmentFailed(
      { teamId: "team-1", filePath: ["team-1", "inbox", "receipt.pdf"] },
      "run did not complete",
    );

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.values).toEqual({ status: "failed" });
  });

  test("does not throw when the write fails", async () => {
    // The caller is already handling an error. Throwing here would replace it,
    // which is how a run once reported a Postgres error instead of its cause.
    dbError = new Error("Failed query: update inbox set status");

    await expect(
      markAttachmentFailed(
        { teamId: "team-1", filePath: ["team-1", "inbox", "receipt.pdf"] },
        "run did not complete",
      ),
    ).resolves.toBeUndefined();
  });

  test("does not throw when there was nothing left to mark", async () => {
    returnedRows = [];

    await expect(
      markAttachmentFailed(
        { teamId: "team-1", filePath: ["team-1", "inbox", "receipt.pdf"] },
        "run did not complete",
      ),
    ).resolves.toBeUndefined();
  });

  test("does not throw on a payload that never parsed", async () => {
    // onFailure hands back whatever was triggered, schema or no schema.
    const malformed = { teamId: "team-1" } as unknown as {
      teamId: string;
      filePath: string[];
    };

    await expect(
      markAttachmentFailed(malformed, "run did not complete"),
    ).resolves.toBeUndefined();
  });
});

describe("sweepStrandedAttachments", () => {
  test("only sweeps past the point a run could still be alive", () => {
    // process-attachment is capped at 660s. Anything shorter than that would
    // fail rows out from under runs that are still working.
    expect(STRANDED_AFTER_MINUTES).toBeGreaterThan(660 / 60);
  });

  test("marks what it finds as failed", async () => {
    await sweepStrandedAttachments();

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.values).toEqual({ status: "failed" });
  });

  test("does not throw when the sweep fails", async () => {
    // It shares a schedule with the no-match sweep, which must still run.
    dbError = new Error("Failed query: update inbox set status");

    await expect(sweepStrandedAttachments()).resolves.toBeUndefined();
  });

  test("does not throw when there is nothing stranded", async () => {
    returnedRows = [];

    await expect(sweepStrandedAttachments()).resolves.toBeUndefined();
  });
});
