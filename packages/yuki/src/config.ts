export const YUKI_REGIONS = ["be", "nl"] as const;

export type YukiRegion = (typeof YUKI_REGIONS)[number];

export interface YukiConfig {
  accessKey: string;
  /**
   * Optional. `Administrations` returns every administration the key can see,
   * so the first run can discover it rather than requiring it up front.
   */
  administrationId?: string;
  region: YukiRegion;
}

/**
 * Belgian domains answer on api.yukiworks.be and Dutch ones on
 * api.yukiworks.nl. Pointing at the wrong one fails with
 * "Domain has no active database", which reads like a permissions problem
 * rather than a wrong host — hence making region explicit rather than
 * defaulting silently.
 */
export function baseUrlFor(region: YukiRegion): string {
  return `https://api.yukiworks.${region}/ws`;
}
