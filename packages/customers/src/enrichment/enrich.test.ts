import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isCompanyEnrichConfigured } from "./company-enrich";
import { enrichCustomer } from "./enrich";

const originalKey = process.env.COMPANY_ENRICH_API_KEY;
const originalFetch = globalThis.fetch;

afterEach(() => {
  if (originalKey === undefined) {
    delete process.env.COMPANY_ENRICH_API_KEY;
  } else {
    process.env.COMPANY_ENRICH_API_KEY = originalKey;
  }
  globalThis.fetch = originalFetch;
});

describe("isCompanyEnrichConfigured", () => {
  test("is false when the key is unset", () => {
    delete process.env.COMPANY_ENRICH_API_KEY;
    expect(isCompanyEnrichConfigured()).toBe(false);
  });

  test("is false when the key is empty", () => {
    process.env.COMPANY_ENRICH_API_KEY = "";
    expect(isCompanyEnrichConfigured()).toBe(false);
  });

  test("is true when the key is set", () => {
    process.env.COMPANY_ENRICH_API_KEY = "ce_test_key";
    expect(isCompanyEnrichConfigured()).toBe(true);
  });
});

describe("enrichCustomer when nothing is learned", () => {
  beforeEach(() => {
    delete process.env.COMPANY_ENRICH_API_KEY;
  });

  test("returns no fields at all rather than every field as null", async () => {
    const result = await enrichCustomer({
      companyName: "Acme",
      website: "https://acme.com",
    });

    expect(result.verified).toEqual({});
    expect(result.raw).toEqual({});
    expect(result.verifiedFieldCount).toBe(0);
    expect(result.metrics.source).toBe("none");
  });

  test("leaves every enrichment field undefined, so the writer skips it", async () => {
    const result = await enrichCustomer({
      companyName: "Acme",
      website: "https://acme.com",
    });

    // updateCustomerEnrichment() copies across anything that is not undefined,
    // so a null here is written over a column a human filled in by hand.
    expect(result.verified.description).toBeUndefined();
    expect(result.verified.industry).toBeUndefined();
    expect(result.verified.vatNumber).toBeUndefined();
  });

  test("learns nothing when the provider has no such company either", async () => {
    process.env.COMPANY_ENRICH_API_KEY = "ce_test_key";
    globalThis.fetch = (async () =>
      new Response(null, { status: 404 })) as unknown as typeof fetch;

    const result = await enrichCustomer({
      companyName: "Acme",
      website: "https://acme.com",
    });

    expect(result.verified).toEqual({});
    expect(result.verifiedFieldCount).toBe(0);
  });
});
