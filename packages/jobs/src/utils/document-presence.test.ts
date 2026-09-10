import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { JobLogger } from "@jobs/processors/types";
import * as queries from "@midday/db/queries";

let rowExists = true;
let rowError: Error | null = null;
let fileExists = true;
let fileError: Error | null = null;
let rowChecks = 0;
let fileChecks = 0;

// Spread the real module: mock.module replaces the whole registry entry for
// the process, so a factory that returns one function makes every other query
// unimportable — including in test files that never asked for a mock.
mock.module("@midday/db/queries", () => ({
  ...queries,
  documentExistsByPath: async () => {
    rowChecks++;
    if (rowError) throw rowError;
    return rowExists;
  },
}));

mock.module("@midday/supabase/job", () => ({
  createClient: () => ({
    storage: {
      from: () => ({
        exists: async () => {
          fileChecks++;
          if (fileError) throw fileError;
          // storage-js reports a 404 as `data: false` with a non-null error.
          return {
            data: fileExists,
            error: fileExists ? null : new Error("404"),
          };
        },
      }),
    },
  }),
}));

const {
  documentWasDeleted,
  explainMissingDocument,
  fileMissingBecauseDeleted,
  outcomeForMissingRow,
} = await import("./document-presence");

const DELETED_LINE =
  "Neither the file nor its documents row is there - treating the document as deleted";

type Line = { level: keyof JobLogger; message: string };

let lines: Line[] = [];

const logger: JobLogger = {
  debug: (message) => lines.push({ level: "debug", message }),
  info: (message) => lines.push({ level: "info", message }),
  warn: (message) => lines.push({ level: "warn", message }),
  error: (message) => lines.push({ level: "error", message }),
};

const ref = {
  db: {} as never,
  fileName: "team-1/inbox/invoice.pdf",
  teamId: "team-1",
  logger,
};

beforeEach(() => {
  rowExists = true;
  rowError = null;
  fileExists = true;
  fileError = null;
  rowChecks = 0;
  fileChecks = 0;
  lines = [];
});

describe("explainMissingDocument", () => {
  test("a missing row whose file is also gone is a deletion", async () => {
    fileExists = false;

    expect(await explainMissingDocument({ ...ref, missing: "row" })).toBe(
      "deleted",
    );
    expect(lines).toEqual([{ level: "info", message: DELETED_LINE }]);
  });

  test("a missing row whose file is still there is an upstream bug", async () => {
    expect(await explainMissingDocument({ ...ref, missing: "row" })).toBe(
      "orphaned",
    );
    expect(lines).toEqual([
      {
        level: "error",
        message:
          "File is in the vault but has no documents row — the row was never created",
      },
    ]);
  });

  test("the two causes never share a log line", async () => {
    fileExists = false;
    await explainMissingDocument({ ...ref, missing: "row" });
    const deleted = lines;

    lines = [];
    fileExists = true;
    await explainMissingDocument({ ...ref, missing: "row" });

    expect(deleted[0]?.message).not.toBe(lines[0]?.message);
    expect(deleted[0]?.level).toBe("info");
    expect(lines[0]?.level).toBe("error");
  });

  test("a check that fails is reported as unknown, not as a deletion", async () => {
    fileError = new Error("storage unreachable");

    expect(await explainMissingDocument({ ...ref, missing: "row" })).toBe(
      "unknown",
    );
    expect(lines.map((line) => line.level)).toEqual(["warn", "error"]);
  });

  test("a missing file whose row is gone is a deletion", async () => {
    rowExists = false;

    expect(await explainMissingDocument({ ...ref, missing: "file" })).toBe(
      "deleted",
    );
  });

  test("a missing file whose row is still there is not a deletion", async () => {
    expect(await explainMissingDocument({ ...ref, missing: "file" })).toBe(
      "orphaned",
    );
    expect(lines).toEqual([
      {
        level: "error",
        message: "Document row exists but its file is gone from the vault",
      },
    ]);
  });
});

describe("documentWasDeleted", () => {
  test("a row that is still there settles it without touching storage", async () => {
    expect(await documentWasDeleted(ref)).toBe(false);
    expect(rowChecks).toBe(1);
    expect(fileChecks).toBe(0);
  });

  test("both halves gone is a deletion", async () => {
    rowExists = false;
    fileExists = false;

    expect(await documentWasDeleted(ref)).toBe(true);
  });

  test("a row missing on its own is not yet a deletion, and not an alarm", async () => {
    rowExists = false;

    expect(await documentWasDeleted(ref)).toBe(false);
    // The row may simply not have been written yet, so saying "never created"
    // here would fire on every one of those races.
    expect(lines).toEqual([]);
  });

  test("a row check that fails is not a deletion", async () => {
    rowError = new Error("database unreachable");

    expect(await documentWasDeleted(ref)).toBe(false);
    expect(fileChecks).toBe(0);
  });
});

describe("fileMissingBecauseDeleted", () => {
  test("true only when the row went with the file", async () => {
    rowExists = false;
    expect(await fileMissingBecauseDeleted(ref)).toBe(true);

    rowExists = true;
    expect(await fileMissingBecauseDeleted(ref)).toBe(false);
  });
});

describe("outcomeForMissingRow", () => {
  test("a deleted document ends the run quietly", async () => {
    fileExists = false;

    expect(await outcomeForMissingRow(ref)).toEqual({
      status: "skipped",
      reason: "document-deleted",
    });
  });

  test("a row that was never created still throws", async () => {
    await expect(outcomeForMissingRow(ref)).rejects.toThrow(
      "Document with path team-1/inbox/invoice.pdf not found",
    );
  });

  test("a check that could not be made still throws", async () => {
    fileError = new Error("storage unreachable");

    await expect(outcomeForMissingRow(ref)).rejects.toThrow(
      "Document with path team-1/inbox/invoice.pdf not found",
    );
  });
});
