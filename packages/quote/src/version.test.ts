import { describe, expect, test } from "bun:test";
import {
  acceptedVersion,
  draftVersion,
  heldVersion,
  isExpired,
  quoteState,
} from "./version";

describe("expired", () => {
  test("a sent version is expired the day after its validity date", () => {
    const sent = { status: "sent" as const, validUntil: "2026-09-30" };
    expect(isExpired(sent, "2026-09-30")).toBe(false);
    expect(isExpired(sent, "2026-10-01")).toBe(true);
  });

  test("only a sent version expires", () => {
    for (const status of ["draft", "superseded", "accepted"] as const) {
      expect(
        isExpired({ status, validUntil: "2026-01-01" }, "2026-10-01"),
      ).toBe(false);
    }
  });
});

const open = { outcome: "open" as const };

test("an open quote reads as its version's status", () => {
  expect(quoteState(open, { status: "draft", expired: false })).toBe("Draft");
  expect(quoteState(open, { status: "sent", expired: false })).toBe("Sent");
});

test("a sent version past its validity reads as expired", () => {
  expect(quoteState(open, { status: "sent", expired: true })).toBe("Expired");
});

test("a revision drafted after the sent version lapsed says both", () => {
  expect(
    quoteState(open, { status: "draft", expired: false }, { expired: true }),
  ).toBe("Draft · expired");
  expect(
    quoteState(open, { status: "draft", expired: false }, { expired: false }),
  ).toBe("Draft");
});

test("an answer recorded on the quote wins over the version", () => {
  expect(
    quoteState({ outcome: "lost" }, { status: "sent", expired: true }),
  ).toBe("Lost");
  expect(
    quoteState({ outcome: "no_decision" }, { status: "sent", expired: false }),
  ).toBe("No decision");
  expect(
    quoteState({ outcome: "won" }, { status: "accepted", expired: false }),
  ).toBe("Won");
});

describe("which version", () => {
  const v = (
    id: string,
    status: "draft" | "sent" | "superseded" | "accepted",
  ) => ({ id, status }) as const;

  test("the draft is the one being written, whatever the client holds", () => {
    const versions = [v("3", "draft"), v("2", "sent"), v("1", "superseded")];
    expect(draftVersion(versions)?.id).toBe("3");
    expect(draftVersion([v("1", "sent")])).toBeUndefined();
  });

  test("the client holds the sent version, or the one they accepted", () => {
    expect(heldVersion([v("3", "draft"), v("2", "sent")])?.id).toBe("2");
    expect(heldVersion([v("2", "draft"), v("1", "accepted")])?.id).toBe("1");
    expect(heldVersion([v("1", "draft")])).toBeUndefined();
    expect(heldVersion([v("2", "superseded")])).toBeUndefined();
  });

  test("only an accepted version is the answer", () => {
    expect(acceptedVersion([v("2", "draft"), v("1", "accepted")])?.id).toBe(
      "1",
    );
    expect(acceptedVersion([v("1", "sent")])).toBeUndefined();
  });
});
