import { createLoggerWithContext } from "@midday/logger";
import { lookupCompany, mapToSchema } from "./company-enrich";
import type {
  EnrichCustomerOptions,
  EnrichCustomerParams,
  EnrichCustomerResult,
  VerifiedEnrichmentData,
} from "./schema";
import { verifyEnrichmentData } from "./verify";

const logger = createLoggerWithContext("Enrichment");

const DEFAULT_TIMEOUT_MS = 30_000;

// ============================================================================
// Main Enrichment Function
// ============================================================================

export async function enrichCustomer(
  params: EnrichCustomerParams,
  options: EnrichCustomerOptions = {},
): Promise<EnrichCustomerResult> {
  const startTime = Date.now();
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: externalSignal } = options;

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => {
    timeoutController.abort(new Error("Enrichment timed out"));
  }, timeoutMs);

  const combinedSignal = externalSignal
    ? AbortSignal.any([externalSignal, timeoutController.signal])
    : timeoutController.signal;

  try {
    const domain = deriveDomain(params.website, params.email);

    logger.info("Starting enrichment", {
      companyName: params.companyName,
      domain,
    });

    const result = await lookupCompany(params.companyName, domain, {
      signal: combinedSignal,
    });

    if (!result) {
      logger.info("Company not found in CompanyEnrich", {
        companyName: params.companyName,
      });
      return emptyResult(Date.now() - startTime);
    }

    // Domain validation only needed for name-based matches.
    // Domain-based matches are deterministic — the API already matched by domain.
    if (
      !result.matchedByDomain &&
      domain &&
      result.data.domain &&
      !domainsMatch(domain, result.data.domain)
    ) {
      logger.info("Domain mismatch on name lookup, discarding result", {
        companyName: params.companyName,
        expected: domain,
        got: result.data.domain,
      });
      return emptyResult(Date.now() - startTime);
    }

    const mapped = mapToSchema(result.data);
    const verified = await verifyEnrichmentData(mapped, {
      signal: combinedSignal,
    });

    const verifiedFieldCount = countPresentFields(verified);
    const durationMs = Date.now() - startTime;

    logger.info("Enrichment complete", {
      companyName: params.companyName,
      verifiedFieldCount,
      durationMs,
      matchedByDomain: result.matchedByDomain,
    });

    return {
      raw: mapped,
      verified,
      verifiedFieldCount,
      metrics: {
        durationMs,
        source: result.matchedByDomain
          ? "companyenrich:domain"
          : "companyenrich:name",
        domainMatch:
          domain && result.data.domain
            ? result.matchedByDomain || domainsMatch(domain, result.data.domain)
            : null,
      },
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================================================
// Helpers
// ============================================================================

function deriveDomain(
  website?: string | null,
  email?: string | null,
): string | null {
  if (website) {
    return extractDomain(website);
  }
  if (email) {
    const atIndex = email.indexOf("@");
    if (atIndex !== -1) {
      const emailDomain = email
        .slice(atIndex + 1)
        .toLowerCase()
        .trim();
      const freeProviders = [
        "gmail.com",
        "yahoo.com",
        "hotmail.com",
        "outlook.com",
        "icloud.com",
        "live.com",
        "me.com",
        "aol.com",
        "protonmail.com",
        "proton.me",
      ];
      if (!freeProviders.includes(emailDomain)) {
        return emailDomain;
      }
    }
  }
  return null;
}

export function extractDomain(website: string): string {
  let result = website;

  if (result.startsWith("https://")) {
    result = result.slice(8);
  } else if (result.startsWith("http://")) {
    result = result.slice(7);
  }

  if (result.startsWith("www.")) {
    result = result.slice(4);
  }

  const slashIndex = result.indexOf("/");
  if (slashIndex !== -1) {
    result = result.slice(0, slashIndex);
  }

  return result.toLowerCase();
}

function domainsMatch(a: string, b: string): boolean {
  const normalize = (d: string) => {
    let s = d.toLowerCase().trim();
    if (s.startsWith("www.")) s = s.slice(4);
    return s;
  };
  return normalize(a) === normalize(b);
}

function countPresentFields(data: Partial<VerifiedEnrichmentData>): number {
  return Object.values(data).filter((v) => v !== null && v !== undefined)
    .length;
}

/**
 * A run that learned nothing.
 *
 * Every field is absent, not null. The database writer copies across anything
 * that is not undefined, so a null here reads as "the provider confirmed this
 * company has no description" and overwrites whatever a human typed. Absent
 * is the only honest way to say we found out nothing.
 */
function emptyResult(durationMs = 0): EnrichCustomerResult {
  return {
    raw: {},
    verified: {},
    verifiedFieldCount: 0,
    metrics: {
      durationMs,
      source: "none",
      domainMatch: false,
    },
  };
}
