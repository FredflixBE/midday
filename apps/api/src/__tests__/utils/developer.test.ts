import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isDeveloper } from "../../utils/developer";

const original = process.env.DEVELOPER_EMAIL;

describe("who counts as the developer", () => {
  beforeEach(() => {
    process.env.DEVELOPER_EMAIL = "dev@example.com";
  });

  afterEach(() => {
    if (original === undefined) {
      // Assigning undefined would leave the literal string "undefined" here,
      // which reads as a configured address.
      delete process.env.DEVELOPER_EMAIL;
    } else {
      process.env.DEVELOPER_EMAIL = original;
    }
  });

  test("recognises the configured address", () => {
    expect(isDeveloper("dev@example.com")).toBe(true);
  });

  test("ignores case and surrounding space on both sides", () => {
    process.env.DEVELOPER_EMAIL = "  Dev@Example.com ";

    expect(isDeveloper("DEV@example.com ")).toBe(true);
  });

  test("refuses anyone else", () => {
    expect(isDeveloper("someone@example.com")).toBe(false);
  });

  test("refuses a session with no email", () => {
    expect(isDeveloper(null)).toBe(false);
    expect(isDeveloper(undefined)).toBe(false);
  });

  test("refuses everyone when the variable is unset", () => {
    // Failing open would hand the deployment-wide jobs to every team member,
    // and would do it silently.
    delete process.env.DEVELOPER_EMAIL;

    expect(isDeveloper("dev@example.com")).toBe(false);
  });

  test("refuses everyone when the variable is blank", () => {
    process.env.DEVELOPER_EMAIL = "   ";

    expect(isDeveloper("dev@example.com")).toBe(false);
  });
});
