import type { YukiConfig, YukiRegion } from "../src/config";
import { YukiConfigError } from "../src/errors";

function assertRegion(value: string): YukiRegion {
  if (value === "be" || value === "nl") return value;
  throw new YukiConfigError(
    `YUKI_REGION must be "be" or "nl", got "${value}". Belgian domains are "be".`,
  );
}

/**
 * Reads credentials from the environment, for these scripts only.
 *
 * It lives here rather than in src so that nothing running inside Midday can
 * reach it: there a client comes from the team's own connection, through
 * `yukiClientForTeam` in `@midday/yuki/team` (FF-1516). An environment key
 * would read one set of books for every team.
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
