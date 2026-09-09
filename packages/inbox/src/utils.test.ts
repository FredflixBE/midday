import { afterEach, describe, expect, test } from "bun:test";
import {
  getInboxEmail,
  getInboxForwardingDomain,
  getInboxIdFromEmail,
  isInboxForwardingEnabled,
} from ".";

const VARS = [
  "INBOX_FORWARDING_DOMAIN",
  "NEXT_PUBLIC_INBOX_FORWARDING_DOMAIN",
] as const;
const original = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));

afterEach(() => {
  for (const v of VARS) {
    if (original[v] === undefined) delete process.env[v];
    else process.env[v] = original[v];
  }
});

function clear() {
  for (const v of VARS) delete process.env[v];
}

test("Get inbox id from email", () => {
  expect(getInboxIdFromEmail("egr34f@inbox.example.com")).toMatch("egr34f");
});

describe("forwarding domain", () => {
  test("is off when nothing is configured", () => {
    clear();
    expect(getInboxForwardingDomain()).toBeNull();
    expect(isInboxForwardingEnabled()).toBe(false);
    expect(getInboxEmail("egr34f")).toBeNull();
  });

  test("reads the server variable", () => {
    clear();
    process.env.INBOX_FORWARDING_DOMAIN = "inbox.example.com";
    expect(isInboxForwardingEnabled()).toBe(true);
    expect(getInboxEmail("egr34f")).toBe("egr34f@inbox.example.com");
  });

  test("falls back to the public variable the dashboard sees", () => {
    clear();
    process.env.NEXT_PUBLIC_INBOX_FORWARDING_DOMAIN = "inbox.example.com";
    expect(getInboxEmail("egr34f")).toBe("egr34f@inbox.example.com");
  });

  test("tolerates a leading @ and surrounding whitespace", () => {
    clear();
    process.env.INBOX_FORWARDING_DOMAIN = "  @inbox.example.com  ";
    expect(getInboxForwardingDomain()).toBe("inbox.example.com");
  });

  test("has no address without an inbox id", () => {
    clear();
    process.env.INBOX_FORWARDING_DOMAIN = "inbox.example.com";
    expect(getInboxEmail("")).toBeNull();
  });
});
