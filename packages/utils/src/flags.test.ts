import { afterEach, describe, expect, test } from "bun:test";
import { isFlagEnabled } from "./flags";

const FLAG = "TEST_SCHEDULER_ENABLED";

afterEach(() => {
  delete process.env[FLAG];
});

describe("isFlagEnabled", () => {
  test("defaults to on when the variable is unset", () => {
    expect(isFlagEnabled(FLAG)).toBe(true);
  });

  test("treats an empty value as unset", () => {
    process.env[FLAG] = "";
    expect(isFlagEnabled(FLAG)).toBe(true);
  });

  test.each([
    "false",
    "FALSE",
    "0",
    "no",
    "off",
    " False ",
  ])("is off for %p", (value) => {
    process.env[FLAG] = value;
    expect(isFlagEnabled(FLAG)).toBe(false);
  });

  test.each(["true", "1", "yes", "on", "anything"])("is on for %p", (value) => {
    process.env[FLAG] = value;
    expect(isFlagEnabled(FLAG)).toBe(true);
  });

  test("can default to off", () => {
    expect(isFlagEnabled(FLAG, { defaultValue: false })).toBe(false);
    process.env[FLAG] = "true";
    expect(isFlagEnabled(FLAG, { defaultValue: false })).toBe(true);
  });
});
