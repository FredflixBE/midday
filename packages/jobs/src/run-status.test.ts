import { describe, expect, test } from "bun:test";
import { settleRun } from "./run-status";

const executing = { status: "EXECUTING", output: undefined, metadata: {} };
const completed = {
  status: "COMPLETED",
  output: { checks: [{ model: "claude-opus-5-5", ok: true }] },
  metadata: {},
};
const failed = {
  status: "FAILED",
  output: undefined,
  error: { message: "invalid x-api-key" },
  metadata: {},
};
const lostConnection = new Error("Could not subscribe to stream");

describe("settleRun", () => {
  test("follows the live connection while it works", () => {
    expect(settleRun({ live: executing })).toMatchObject({
      status: "active",
      lostTrack: false,
    });
  });

  test("keeps a finished result when the connection errors afterwards", () => {
    // What production showed: the run had answered, and the page still said it
    // had lost track of it.
    expect(
      settleRun({ live: completed, liveError: lostConnection }),
    ).toMatchObject({
      status: "completed",
      result: completed.output,
      lostTrack: false,
    });
  });

  test("takes the result from the direct lookup when the connection dropped first", () => {
    expect(
      settleRun({
        live: executing,
        liveError: lostConnection,
        lookup: completed,
      }),
    ).toMatchObject({
      status: "completed",
      result: completed.output,
      lostTrack: false,
    });
  });

  test("reports a failed run's reason from the lookup", () => {
    expect(
      settleRun({ liveError: lostConnection, lookup: failed }),
    ).toMatchObject({ status: "failed", error: "invalid x-api-key" });
  });

  test("is still running, not lost, while the lookup has no answer yet", () => {
    expect(
      settleRun({ live: executing, liveError: lostConnection }),
    ).toMatchObject({ status: "active", lostTrack: false });
  });

  test("has lost track only when the lookup fails too", () => {
    expect(
      settleRun({
        live: executing,
        liveError: lostConnection,
        lookupError: new Error("Failed to fetch"),
      }),
    ).toMatchObject({ lostTrack: true });
  });
});
