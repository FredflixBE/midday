import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getAllowedAssetHosts, isAllowedAssetUrl } from "./asset-hosts";

const VARS = [
  "NODE_ENV",
  "SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "CDN_URL",
  "DASHBOARD_URL",
  "NEXT_PUBLIC_URL",
  "API_URL",
  "NEXT_PUBLIC_API_URL",
  "ALLOWED_ASSET_HOSTS",
] as const;

const original = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));

beforeEach(() => {
  for (const v of VARS) delete process.env[v];
});

afterEach(() => {
  for (const v of VARS) {
    if (original[v] === undefined) delete process.env[v];
    else process.env[v] = original[v];
  }
});

describe("getAllowedAssetHosts", () => {
  test("collects the storage, cdn, dashboard and api hosts", () => {
    process.env.SUPABASE_URL = "https://abcdef.supabase.co";
    process.env.CDN_URL = "https://cdn.example.com";
    process.env.DASHBOARD_URL = "https://midday.example.com";
    process.env.API_URL = "https://api.example.com";

    expect(getAllowedAssetHosts()).toEqual(
      new Set([
        "abcdef.supabase.co",
        "cdn.example.com",
        "midday.example.com",
        "api.example.com",
      ]),
    );
  });

  test("adds ALLOWED_ASSET_HOSTS entries", () => {
    process.env.DASHBOARD_URL = "https://midday.example.com";
    process.env.ALLOWED_ASSET_HOSTS = "img.logo.dev, Images.Example.COM";

    const hosts = getAllowedAssetHosts();
    expect(hosts.has("img.logo.dev")).toBe(true);
    expect(hosts.has("images.example.com")).toBe(true);
  });

  test("ignores unparseable values instead of throwing", () => {
    process.env.SUPABASE_URL = "not a url";
    process.env.DASHBOARD_URL = "https://midday.example.com";
    process.env.API_URL = "https://midday.example.com";
    expect(getAllowedAssetHosts()).toEqual(new Set(["midday.example.com"]));
  });

  test("survives production with no URLs configured at all", () => {
    process.env.NODE_ENV = "production";
    expect(() => getAllowedAssetHosts()).not.toThrow();
    expect(getAllowedAssetHosts().size).toBe(0);
  });
});

describe("outside production", () => {
  test("the local dev ports are allowed, so a dev upload renders", () => {
    expect(getAllowedAssetHosts()).toEqual(new Set(["localhost"]));
  });
});

describe("isAllowedAssetUrl", () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = "https://abcdef.supabase.co";
    process.env.DASHBOARD_URL = "https://midday.example.com";
  });

  test("accepts an upload on the project's storage host", () => {
    expect(
      isAllowedAssetUrl(
        "https://abcdef.supabase.co/storage/v1/object/public/avatars/a.png",
      ),
    ).toBe(true);
  });

  test("accepts this deployment's own dashboard host", () => {
    expect(isAllowedAssetUrl("https://midday.example.com/logo.png")).toBe(true);
  });

  test("rejects an unrelated host", () => {
    expect(isAllowedAssetUrl("https://cdn.midday.ai/logos/acme.png")).toBe(
      false,
    );
    expect(isAllowedAssetUrl("http://169.254.169.254/latest/meta-data")).toBe(
      false,
    );
  });

  test("rejects a subdomain of an allowed host", () => {
    expect(isAllowedAssetUrl("https://evil.midday.example.com/x.png")).toBe(
      false,
    );
  });

  test("rejects non-http protocols", () => {
    expect(isAllowedAssetUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedAssetUrl("data:image/png;base64,AAAA")).toBe(false);
  });

  test("rejects empty and malformed input", () => {
    expect(isAllowedAssetUrl("")).toBe(false);
    expect(isAllowedAssetUrl("://nope")).toBe(false);
  });
});
