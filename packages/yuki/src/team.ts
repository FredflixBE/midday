import type { Database } from "@midday/db/client";
import { createApp, getAppByAppId } from "@midday/db/queries";
import { decrypt, encrypt } from "@midday/encryption";
import { verifyAccess, YukiAccessError } from "./access";
import { type FetchLike, YukiClient, type YukiClientConfig } from "./client";
import type { YukiRegion } from "./config";

/**
 * Yuki is an app a team connects, not a setting of the installation (FF-1516).
 * This module is the only place that writes a team's connection and the only
 * place that turns one back into a client, so the stored shape lives here.
 *
 * Nothing that runs in Midday may build a client from the environment:
 * `configFromEnv` is for packages/yuki/scripts only.
 */

export const YUKI_APP_ID = "yuki";

/** Raised for a team with no Yuki app. A job should skip that team, not fail. */
export class YukiNotConnectedError extends Error {
  readonly teamId: string;

  constructor(teamId: string) {
    super(`Team ${teamId} has not connected Yuki.`);
    this.name = "YukiNotConnectedError";
    this.teamId = teamId;
  }
}

/**
 * Checks the key with Yuki, read-only, and only then stores it, encrypted.
 * Answers with what the user may see, which never includes the key.
 */
export async function connectYuki(
  db: Database,
  params: {
    teamId: string;
    userId: string;
    accessKey: string;
    region: YukiRegion;
    administrationId: string;
  },
  options: { fetchImpl?: FetchLike } = {},
): Promise<{ administrationName: string; region: YukiRegion }> {
  const { teamId, userId, accessKey, region, administrationId } = params;

  const { administrations } = await verifyAccess(
    { accessKey, region },
    options,
  );

  const administration = administrations.find((a) => a.id === administrationId);
  if (!administration) {
    throw new YukiAccessError("unknown_administration");
  }

  await createApp(db, {
    teamId,
    createdBy: userId,
    appId: YUKI_APP_ID,
    config: {
      encryptedAccessKey: encrypt(accessKey),
      region,
      administrationId,
      administrationName: administration.name,
    },
  });

  return { administrationName: administration.name, region };
}

/**
 * The one way to get a Yuki client inside Midday: from the team's own `apps`
 * row. Throws `YukiNotConnectedError` for a team without one, before anything
 * reaches the network.
 */
export async function yukiClientForTeam(
  db: Database,
  teamId: string,
  options: Pick<
    YukiClientConfig,
    "allowWriteOperations" | "timeoutMs" | "fetchImpl"
  > = {},
): Promise<YukiClient> {
  const app = await getAppByAppId(db, { appId: YUKI_APP_ID, teamId });
  if (!app?.config) {
    throw new YukiNotConnectedError(teamId);
  }

  const { encryptedAccessKey, region, administrationId } = app.config;

  return new YukiClient({
    ...options,
    accessKey: decrypt(encryptedAccessKey),
    region,
    administrationId,
  });
}
