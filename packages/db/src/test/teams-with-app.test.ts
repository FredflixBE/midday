/**
 * Seam under test: which teams a scheduled per-team job fans out over. Yuki
 * is connected per team (FF-1516), so its scheduled work must reach exactly
 * the teams that connected it, and a team that did not is never in the list.
 *
 * Needs the throwaway Postgres from docker-compose.test.yml:
 *   docker compose -f docker-compose.test.yml up -d
 *   bun run test:e2e:setup
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/midday_test bun test src/test/teams-with-app.test.ts
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "../client";
import { createApp, disconnectApp, getTeamIdsWithApp } from "../queries/apps";
import {
  seedAll,
  TEAM_EUR_ID,
  TEAM_USD_ID,
  TEST_USER_ID,
} from "./helpers/seed";
import {
  cleanDatabase,
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

const SKIP = !isTestDatabaseAvailable();

const yukiConfig = {
  encryptedAccessKey: "not-a-real-ciphertext",
  region: "be" as const,
  administrationId: "11111111-1111-1111-1111-111111111111",
  administrationName: "Acme BV",
};

describe.skipIf(SKIP)("teams with an app", () => {
  let db: Database;

  beforeEach(async () => {
    db = getTestDatabase();
    await cleanDatabase();
    await seedAll(db);
  });

  afterAll(async () => {
    await closeDatabase();
  });

  test("lists only the teams that connected that app", async () => {
    await createApp(db, {
      teamId: TEAM_EUR_ID,
      createdBy: TEST_USER_ID,
      appId: "yuki",
      config: yukiConfig,
    });
    // Another app on the second team does not make it a Yuki team.
    await createApp(db, {
      teamId: TEAM_USD_ID,
      createdBy: TEST_USER_ID,
      appId: "slack",
      settings: [],
    });

    expect(await getTeamIdsWithApp(db, "yuki")).toEqual([TEAM_EUR_ID]);
  });

  test("drops a team once it disconnects", async () => {
    await createApp(db, {
      teamId: TEAM_EUR_ID,
      createdBy: TEST_USER_ID,
      appId: "yuki",
      config: yukiConfig,
    });

    await disconnectApp(db, { appId: "yuki", teamId: TEAM_EUR_ID });

    expect(await getTeamIdsWithApp(db, "yuki")).toEqual([]);
  });
});
