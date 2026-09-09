import { createHash } from "node:crypto";
import { isGoCardlessConfigured } from "./env";
import { EnableBankingApi } from "./providers/enablebanking/enablebanking-api";
import { GoCardLessApi } from "./providers/gocardless/gocardless-api";
import type { Providers } from "./types";

export type InstitutionRecord = {
  id: string;
  name: string;
  logo: string | null;
  provider: Providers;
  countries: string[];
  availableHistory: number | null;
  maximumConsentValidity: number | null;
  popularity: number;
  type: string | null;
};

export type FetchInstitutionsResult = {
  institutions: InstitutionRecord[];
  errors: { provider: string; error: string }[];
  succeededProviders: Providers[];
};

async function fetchEnableBankingInstitutions(): Promise<InstitutionRecord[]> {
  const api = new EnableBankingApi();
  const data = await api.getInstitutions();

  return data.flatMap((institution) => {
    const hashId = createHash("md5")
      .update(`${institution.name}-${institution.country}`)
      .digest("hex")
      .slice(0, 12);

    return (institution.psu_types ?? []).map((psuType: string) => ({
      id: psuType === "business" ? hashId : `${hashId}-personal`,
      name: institution.name,
      logo: institution.logo ?? null,
      provider: "enablebanking" as const,
      countries: [institution.country],
      availableHistory: null,
      maximumConsentValidity: institution.maximum_consent_validity ?? null,
      popularity: 10000,
      type: psuType,
    }));
  });
}

async function fetchGoCardLessInstitutions(): Promise<InstitutionRecord[]> {
  const api = new GoCardLessApi();
  const data = await api.getInstitutions();

  return data.map((institution) => {
    return {
      id: institution.id,
      name: institution.name,
      logo: institution.logo ?? null,
      provider: "gocardless" as const,
      countries: institution.countries,
      availableHistory: institution.transaction_total_days
        ? Number(institution.transaction_total_days)
        : null,
      maximumConsentValidity: null,
      popularity: 0,
      type: null,
    };
  });
}

/**
 * Fetch institutions from every configured banking provider.
 * Each provider resolves its own env vars internally; GoCardless is skipped
 * when it is not configured. Returns both the fetched institutions and any
 * errors that occurred.
 */
export async function fetchAllInstitutions(): Promise<FetchInstitutionsResult> {
  const fetchers: {
    provider: Providers;
    fetch: () => Promise<InstitutionRecord[]>;
  }[] = [{ provider: "enablebanking", fetch: fetchEnableBankingInstitutions }];

  if (isGoCardlessConfigured()) {
    fetchers.push({
      provider: "gocardless",
      fetch: fetchGoCardLessInstitutions,
    });
  }

  const results = await Promise.allSettled(fetchers.map((f) => f.fetch()));

  const institutions: InstitutionRecord[] = [];
  const errors: { provider: string; error: string }[] = [];
  const succeededProviders: Providers[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    const provider = fetchers[i]!.provider;
    if (result.status === "fulfilled") {
      institutions.push(...result.value);
      succeededProviders.push(provider);
    } else {
      errors.push({
        provider,
        error: result.reason?.message ?? "Unknown error",
      });
    }
  }

  return { institutions, errors, succeededProviders };
}
