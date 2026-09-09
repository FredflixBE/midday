import { afterEach, describe, expect, test } from "bun:test";
import { getFeatureAvailability } from "@api/utils/availability";

const VARS = [
  "OPENAI_API_KEY",
  "COMPOSIO_API_KEY",
  "COMPANY_ENRICH_API_KEY",
  "FORTNOX_CLIENT_ID",
  "FORTNOX_CLIENT_SECRET",
  "INSIGHTS_ENABLED",
  "QUICKBOOKS_CLIENT_ID",
  "QUICKBOOKS_CLIENT_SECRET",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "SLACK_SIGNING_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_CONNECT_CLIENT_ID",
  "XERO_CLIENT_ID",
  "XERO_CLIENT_SECRET",
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

describe("getFeatureAvailability", () => {
  test("everything is off when nothing is configured", () => {
    clear();
    expect(getFeatureAvailability()).toEqual({
      assistant: false,
      connectors: false,
      enrichment: false,
      fortnox: false,
      insights: false,
      quickbooks: false,
      slack: false,
      stripe: false,
      xero: false,
    });
  });

  test("a half-configured integration stays off", () => {
    clear();
    process.env.XERO_CLIENT_ID = "id";
    expect(getFeatureAvailability().xero).toBe(false);
    process.env.XERO_CLIENT_SECRET = "secret";
    expect(getFeatureAvailability().xero).toBe(true);
  });

  test("Stripe needs both the secret key and the Connect client id", () => {
    clear();
    process.env.STRIPE_SECRET_KEY = "sk_test";
    expect(getFeatureAvailability().stripe).toBe(false);
    process.env.STRIPE_CONNECT_CLIENT_ID = "ca_test";
    expect(getFeatureAvailability().stripe).toBe(true);
  });

  test("insights are off unless explicitly enabled", () => {
    clear();
    process.env.INSIGHTS_ENABLED = "false";
    expect(getFeatureAvailability().insights).toBe(false);
    process.env.INSIGHTS_ENABLED = "true";
    expect(getFeatureAvailability().insights).toBe(true);
  });

  test("the assistant follows the OpenAI key", () => {
    clear();
    expect(getFeatureAvailability().assistant).toBe(false);
    process.env.OPENAI_API_KEY = "sk-test";
    expect(getFeatureAvailability().assistant).toBe(true);
  });
});
