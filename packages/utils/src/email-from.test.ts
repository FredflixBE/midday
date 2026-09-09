import { afterEach, describe, expect, test } from "bun:test";
import { getEmailFrom } from "./email-from";

const original = {
  EMAIL_FROM: process.env.EMAIL_FROM,
  EMAIL_FROM_NAME: process.env.EMAIL_FROM_NAME,
};

afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function set(from?: string, name?: string) {
  if (from === undefined) delete process.env.EMAIL_FROM;
  else process.env.EMAIL_FROM = from;
  if (name === undefined) delete process.env.EMAIL_FROM_NAME;
  else process.env.EMAIL_FROM_NAME = name;
}

describe("getEmailFrom", () => {
  test("throws when EMAIL_FROM is unset", () => {
    set(undefined);
    expect(() => getEmailFrom()).toThrow(/EMAIL_FROM is not set/);
  });

  test("passes a bare address through", () => {
    set("midday@example.com");
    expect(getEmailFrom()).toBe("midday@example.com");
  });

  test("keeps the display name configured in EMAIL_FROM", () => {
    set("Midday <midday@example.com>");
    expect(getEmailFrom()).toBe("Midday <midday@example.com>");
  });

  test("EMAIL_FROM_NAME overrides the configured name", () => {
    set("Midday <midday@example.com>", "Acme Books");
    expect(getEmailFrom()).toBe("Acme Books <midday@example.com>");
  });

  test("an explicit display name wins over both", () => {
    set("Midday <midday@example.com>", "Acme Books");
    expect(getEmailFrom("Team Fredflix")).toBe(
      "Team Fredflix <midday@example.com>",
    );
  });

  test("names the address even when EMAIL_FROM has no display name", () => {
    set("midday@example.com");
    expect(getEmailFrom("Acme")).toBe("Acme <midday@example.com>");
  });

  test("quotes a display name containing RFC 5322 specials", () => {
    set("midday@example.com");
    expect(getEmailFrom("Acme, Inc.")).toBe(
      '"Acme, Inc." <midday@example.com>',
    );
    expect(getEmailFrom('He said "hi"')).toBe(
      '"He said \\"hi\\"" <midday@example.com>',
    );
  });

  test("tolerates whitespace around the configured identity", () => {
    set("  Midday  <  midday@example.com  >  ");
    expect(getEmailFrom()).toBe("Midday <midday@example.com>");
  });

  test("an empty display name falls back rather than producing '<addr>'", () => {
    set("Midday <midday@example.com>");
    expect(getEmailFrom("   ")).toBe("Midday <midday@example.com>");
  });
});
