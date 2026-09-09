import { describe, expect, test } from "bun:test";
import {
  extractConnectionToken,
  isExplicitConnectionAttempt,
} from "../../bot/linking";

describe("bot link code extraction", () => {
  test("extracts prefixed 'Connect to Midday:' messages", () => {
    expect(extractConnectionToken("Connect to Midday: abc12345")).toBe(
      "abc12345",
    );
    expect(extractConnectionToken("Connect to Midday: xyzABCDE")).toBe(
      "xyzABCDE",
    );
    expect(extractConnectionToken("connect to midday:abc12345")).toBe(
      "abc12345",
    );
  });

  test("extracts bare code-only messages with mixed alphanumeric", () => {
    expect(extractConnectionToken("abc12345")).toBe("abc12345");
    expect(extractConnectionToken("a1b2c3d4")).toBe("a1b2c3d4");
    expect(extractConnectionToken("Abc1defg")).toBe("Abc1defg");
  });

  test("ignores non-link messages", () => {
    expect(extractConnectionToken("hello there")).toBeNull();
    expect(extractConnectionToken("Summarize my cash flow")).toBeNull();
  });

  test("ignores bare 8-char English words (no digit)", () => {
    const words = [
      "password",
      "question",
      "business",
      "checkout",
      "download",
      "children",
      "absolute",
      "learning",
      "practice",
      "pictures",
    ];
    for (const word of words) {
      expect(extractConnectionToken(word)).toBeNull();
    }
  });

  test("ignores multi-word messages without the connect prefix", () => {
    expect(extractConnectionToken("What about checkout")).toBeNull();
    expect(extractConnectionToken("Here is my abc12345")).toBeNull();
    expect(extractConnectionToken("please try a1b2c3d4")).toBeNull();
  });

  test("ignores bare pure-digit 8-char strings", () => {
    expect(extractConnectionToken("12345678")).toBeNull();
    expect(extractConnectionToken("99887766")).toBeNull();
  });
});

describe("isExplicitConnectionAttempt", () => {
  test("returns true for 'Connect to Midday:' prefix", () => {
    expect(isExplicitConnectionAttempt("Connect to Midday: abc12345")).toBe(
      true,
    );
    expect(isExplicitConnectionAttempt("connect to midday:abc12345")).toBe(
      true,
    );
  });

  test("returns false for bare alphanumeric strings", () => {
    expect(isExplicitConnectionAttempt("abc12345")).toBe(false);
    expect(isExplicitConnectionAttempt("test1234")).toBe(false);
    expect(isExplicitConnectionAttempt("a1b2c3d4")).toBe(false);
  });

  test("returns false for regular messages", () => {
    expect(isExplicitConnectionAttempt("hello there")).toBe(false);
    expect(isExplicitConnectionAttempt(undefined)).toBe(false);
    expect(isExplicitConnectionAttempt("just chatting")).toBe(false);
  });
});
