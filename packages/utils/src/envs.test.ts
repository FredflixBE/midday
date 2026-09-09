import { afterEach, describe, expect, test } from "bun:test";
import { getApiUrl, getAppUrl, getCdnUrl, getEmailUrl } from "./envs";

const VARS = [
  "NODE_ENV",
  "DASHBOARD_URL",
  "NEXT_PUBLIC_URL",
  "API_URL",
  "NEXT_PUBLIC_API_URL",
  "EMAIL_ASSETS_URL",
  "CDN_URL",
] as const;

const original = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));

afterEach(() => {
  for (const v of VARS) {
    if (original[v] === undefined) {
      delete process.env[v];
    } else {
      process.env[v] = original[v];
    }
  }
});

function clear() {
  for (const v of VARS) delete process.env[v];
}

describe("getAppUrl", () => {
  test("reads DASHBOARD_URL", () => {
    clear();
    process.env.DASHBOARD_URL = "https://midday.example.com";
    expect(getAppUrl()).toBe("https://midday.example.com");
  });

  test("falls back to the dashboard's own NEXT_PUBLIC_URL", () => {
    clear();
    process.env.NEXT_PUBLIC_URL = "https://midday.example.com";
    expect(getAppUrl()).toBe("https://midday.example.com");
  });

  test("strips a trailing slash", () => {
    clear();
    process.env.DASHBOARD_URL = "https://midday.example.com/";
    expect(getAppUrl()).toBe("https://midday.example.com");
  });

  test("falls back to localhost outside production", () => {
    clear();
    expect(getAppUrl()).toBe("http://localhost:3001");
  });

  test("throws in production when unset", () => {
    clear();
    process.env.NODE_ENV = "production";
    expect(() => getAppUrl()).toThrow(/DASHBOARD_URL is not set/);
  });
});

describe("getApiUrl", () => {
  test("reads API_URL, then NEXT_PUBLIC_API_URL", () => {
    clear();
    process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
    expect(getApiUrl()).toBe("https://api.example.com");
    process.env.API_URL = "https://api.internal.example.com";
    expect(getApiUrl()).toBe("https://api.internal.example.com");
  });

  test("throws in production when unset", () => {
    clear();
    process.env.NODE_ENV = "production";
    expect(() => getApiUrl()).toThrow(/API_URL is not set/);
  });
});

describe("asset hosts", () => {
  test("default to the dashboard", () => {
    clear();
    process.env.DASHBOARD_URL = "https://midday.example.com";
    expect(getEmailUrl()).toBe("https://midday.example.com");
    expect(getCdnUrl()).toBe("https://midday.example.com");
  });

  test("can be overridden independently", () => {
    clear();
    process.env.DASHBOARD_URL = "https://midday.example.com";
    process.env.EMAIL_ASSETS_URL = "https://assets.example.com/";
    process.env.CDN_URL = "https://cdn.example.com";
    expect(getEmailUrl()).toBe("https://assets.example.com");
    expect(getCdnUrl()).toBe("https://cdn.example.com");
  });
});
