/**
 * Seam under test: which teams go when a user deletes their account, against
 * a real Postgres — the answer depends on counting other people's memberships
 * and on how the driver hands back a count, which no fake driver can check.
 *
 * Needs the throwaway Postgres from docker-compose.test.yml:
 *   docker compose -f docker-compose.test.yml up -d
 *   bun run test:e2e:setup
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/midday_test bun test src/test/sole-member-teams.test.ts
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { Database } from "../client";
import { deleteUser, getSoleMemberTeamIds } from "../queries/users";
import { teams, users, usersOnTeam } from "../schema";
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

const COLLEAGUE_ID = "00000000-0000-0000-0000-000000000098";

describe.skipIf(SKIP)("teams deleted with a user", () => {
  let db: Database;

  beforeEach(async () => {
    db = getTestDatabase();
    await cleanDatabase();
    await seedAll(db);

    await db.execute(sql`
      insert into auth.users (id, email) values (${COLLEAGUE_ID}, 'colleague@midday.ai')
      on conflict (id) do nothing
    `);
    await db
      .insert(users)
      .values({ id: COLLEAGUE_ID, email: "colleague@midday.ai" })
      .onConflictDoNothing();

    // The test user is alone on the USD team and shares the EUR team.
    await db.insert(usersOnTeam).values([
      { userId: TEST_USER_ID, teamId: TEAM_USD_ID, role: "owner" },
      { userId: TEST_USER_ID, teamId: TEAM_EUR_ID, role: "owner" },
      { userId: COLLEAGUE_ID, teamId: TEAM_EUR_ID, role: "member" },
    ]);
  });

  afterAll(async () => {
    await closeDatabase();
  });

  test("are the teams the user is the only member of", async () => {
    expect(await getSoleMemberTeamIds(db, TEST_USER_ID)).toEqual([TEAM_USD_ID]);
  });

  test("go with the user's account, and a team someone else is still on stays", async () => {
    await deleteUser(db, TEST_USER_ID);

    const remaining = await db.select({ id: teams.id }).from(teams);
    expect(remaining.map((team) => team.id)).toEqual([TEAM_EUR_ID]);
  });
});
