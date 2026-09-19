import { expect, test } from "bun:test";
import { quoteState } from "./quote-state";

const open = { outcome: "open" as const };

test("an open quote reads as its version's status", () => {
  expect(quoteState(open, { status: "draft", expired: false })).toBe("Draft");
  expect(quoteState(open, { status: "sent", expired: false })).toBe("Sent");
});

test("a sent version past its validity reads as expired", () => {
  expect(quoteState(open, { status: "sent", expired: true })).toBe("Expired");
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
