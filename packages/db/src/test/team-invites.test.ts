/**
 * Seam under test: which pending invites a signed-in user has. Sign-in asks
 * this before it sends a user without a team to onboarding (FF-1542), so an
 * invite this misses is an invited user creating a second team of their own.
 *
 * Needs the throwaway Postgres from docker-compose.test.yml:
 *   docker compose -f docker-compose.test.yml up -d
 *   bun run test:e2e:setup
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/midday_test bun test src/test/team-invites.test.ts
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Database } from "../client";
import { declineTeamInvite, getInvitesByEmail } from "../queries/user-invites";
import { userInvites } from "../schema";
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

describe.skipIf(SKIP)("pending invites for a signed-in email", () => {
  let db: Database;

  beforeEach(async () => {
    db = getTestDatabase();
    await cleanDatabase();
    await seedAll(db);
  });

  afterAll(async () => {
    await closeDatabase();
  });

  test("are the invites sent to that address, on every team", async () => {
    await db.insert(userInvites).values([
      {
        teamId: TEAM_EUR_ID,
        email: "support@fredflix.be",
        role: "member",
        invitedBy: TEST_USER_ID,
      },
      {
        teamId: TEAM_USD_ID,
        email: "support@fredflix.be",
        role: "owner",
        invitedBy: TEST_USER_ID,
      },
      {
        teamId: TEAM_EUR_ID,
        email: "someone-else@fredflix.be",
        role: "member",
        invitedBy: TEST_USER_ID,
      },
    ]);

    const invites = await getInvitesByEmail(db, "support@fredflix.be");

    expect(invites.map((invite) => invite.team?.id).sort()).toEqual(
      [TEAM_EUR_ID, TEAM_USD_ID].sort(),
    );
  });

  test("include an invite typed with different capitals than the sign-in email", async () => {
    // The invite form stores the address as typed; Google signs the user in
    // with it lower-cased. Accepting already compares without case.
    await db.insert(userInvites).values({
      teamId: TEAM_EUR_ID,
      email: "Support@Fredflix.be",
      role: "member",
      invitedBy: TEST_USER_ID,
    });

    const invites = await getInvitesByEmail(db, "support@fredflix.be");

    expect(invites.map((invite) => invite.team?.id)).toEqual([TEAM_EUR_ID]);
  });

  test("are none for an address nobody invited", async () => {
    await db.insert(userInvites).values({
      teamId: TEAM_EUR_ID,
      email: "support@fredflix.be",
      role: "member",
      invitedBy: TEST_USER_ID,
    });

    expect(await getInvitesByEmail(db, "frederik@fredflix.be")).toEqual([]);
  });

  test("can be declined whatever the capitals the invite was typed with", async () => {
    const [invite] = await db
      .insert(userInvites)
      .values({
        teamId: TEAM_EUR_ID,
        email: "Support@Fredflix.be",
        role: "member",
        invitedBy: TEST_USER_ID,
      })
      .returning({ id: userInvites.id });

    await declineTeamInvite(db, {
      id: invite!.id,
      email: "support@fredflix.be",
    });

    const left = await db
      .select({ id: userInvites.id })
      .from(userInvites)
      .where(eq(userInvites.id, invite!.id));
    expect(left).toEqual([]);
  });
});
