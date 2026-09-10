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

const { failedBatchItems, markAttachmentFailed } = await import(
  "./attachment-failure"
);

/**
 * The plain values bound into the `meta` expression of the last update. The
 * merge itself is checked against Postgres in packages/db; this only needs to
 * know which reason was handed to it.
 */
function boundValuesOfMeta(): unknown[] {
  const values = updateCalls.at(-1)?.values as
    | { meta?: { queryChunks?: unknown[] } }
    | undefined;
  return (values?.meta?.queryChunks ?? []).filter(
    (chunk) => chunk === null || typeof chunk === "string",
  );
}

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
    expect(updateCalls[0]?.values).toMatchObject({ status: "failed" });
  });

  test("records the reason when the uploader should see it", async () => {
    await markAttachmentFailed(
      { teamId: "team-1", filePath: ["team-1", "inbox", "IMG_4179.HEIC"] },
      "This photo is 48.8 megapixels, more than the 32 we can convert.",
      { tellUploader: true },
    );

    expect(boundValuesOfMeta()).toContain(
      "This photo is 48.8 megapixels, more than the 32 we can convert.",
    );
  });

  test("keeps an internal reason out of what the uploader sees", async () => {
    // The reason onFailure has is a run's error message — a timeout, a
    // Postgres error — not something to put in front of a user.
    await markAttachmentFailed(
      { teamId: "team-1", filePath: ["team-1", "inbox", "receipt.pdf"] },
      "Document processing timed out after 600000ms",
    );

    expect(boundValuesOfMeta()).not.toContain(
      "Document processing timed out after 600000ms",
    );
    expect(boundValuesOfMeta()).toContain(null);
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
