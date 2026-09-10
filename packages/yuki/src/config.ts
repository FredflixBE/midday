import { YukiConfigError } from "./errors";

export type YukiRegion = "be" | "nl";

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

function assertRegion(value: string): YukiRegion {
  if (value === "be" || value === "nl") return value;
  throw new YukiConfigError(
    `YUKI_REGION must be "be" or "nl", got "${value}". Belgian domains are "be".`,
  );
}

/**
 * Reads credentials from the environment.
 *
 * These belong in packages/yuki/.env. Deliberately not in packages/db/.env:
 * `bun run` auto-loads the nearest .env, and that file points
 * DATABASE_SESSION_POOLER at the live Frankfurt Supabase project.
 */
export function configFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): YukiConfig {
  const accessKey = env.YUKI_ACCESS_KEY?.trim();
  const administrationId = env.YUKI_ADMINISTRATION_ID?.trim();
  const region = env.YUKI_REGION?.trim() || "be";

  if (!accessKey) {
    throw new YukiConfigError(
      "YUKI_ACCESS_KEY is not set. Create one in Yuki under Settings > Web services, and put it in packages/yuki/.env (see .env.example).",
    );
  }

  // administrationId is deliberately not required: the Administrations probe
  // reports it, so a first run needs only the access key.
  return { accessKey, administrationId, region: assertRegion(region) };
}
