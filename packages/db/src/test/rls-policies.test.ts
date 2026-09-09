/**
 * What the restored policies actually allow, asked of a real database as the
 * `authenticated` role rather than of the catalog.
 *
 * This is the only kind of test that can see these: `apps/api` connects as the
 * table owner and bypasses RLS entirely, so every other test in the suite
 * passes whether a policy grants everything, the right thing, or nothing at
 * all. 44 policies sat with no expression — granting nothing — for as long as
 * nobody looked.
 *
 * Needs the throwaway Postgres from docker-compose.test.yml:
 *   docker compose -f docker-compose.test.yml up -d
 *   bun run test:e2e:setup
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/midday_test \
 *     bun test src/test/rls-policies.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "pg";
import { asRole } from "./helpers/as-role";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_DATABASE_URL;

const TEAM = "eeeeeeee-0000-0000-0000-000000000001";
const OTHER_TEAM = "eeeeeeee-0000-0000-0000-000000000002";
const MEMBER = "eeeeeeee-0000-0000-0000-000000000003";
const STRANGER = "eeeeeeee-0000-0000-0000-000000000004";
const INVITEE = "eeeeeeee-0000-0000-0000-000000000005";
const INVITEE_EMAIL = "invitee@example.test";

describe.skipIf(SKIP)("row level security, as a browser sees it", () => {
  let client: Client;

  async function ids(sql: string, params: unknown[] = []) {
    const { rows } = await client.query<{ id: string }>(sql, params);
    return rows.map((row) => row.id).sort();
  }

  /** Every row this file makes, in dependency order. Idempotent. */
  async function cleanup() {
    await client.query(
      "delete from insight_user_status where user_id in ($1, $2, $3)",
      [MEMBER, STRANGER, INVITEE],
    );

    for (const table of [
      "insights",
      "tracker_entries",
      "bank_accounts",
      "apps",
      "user_invites",
      "users_on_team",
    ]) {
      await client.query(`delete from ${table} where team_id in ($1, $2)`, [
        TEAM,
        OTHER_TEAM,
      ]);
    }

    await client.query("delete from teams where id in ($1, $2)", [
      TEAM,
      OTHER_TEAM,
    ]);
    await client.query("delete from users where id in ($1, $2, $3)", [
      MEMBER,
      STRANGER,
      INVITEE,
    ]);
    await client.query("delete from auth.users where id in ($1, $2, $3)", [
      MEMBER,
      STRANGER,
      INVITEE,
    ]);
  }

  beforeAll(async () => {
    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();

    // A run that died before afterAll would otherwise poison every later one.
    await cleanup();

    for (const [id, email] of [
      [MEMBER, "member@example.test"],
      [STRANGER, "stranger@example.test"],
      [INVITEE, INVITEE_EMAIL],
    ]) {
      await client.query(
        "insert into auth.users (id, email) values ($1, $2) on conflict do nothing",
        [id, email],
      );
      await client.query(
        "insert into users (id, email) values ($1, $2) on conflict do nothing",
        [id, email],
      );
    }

    await client.query(
      `insert into teams (id, name) values ($1, 'RLS Team'), ($2, 'Other Team')
       on conflict do nothing`,
      [TEAM, OTHER_TEAM],
    );

    // MEMBER belongs to TEAM only; STRANGER to OTHER_TEAM only.
    await client.query(
      `insert into users_on_team (user_id, team_id, role)
       values ($1, $2, 'owner'), ($3, $4, 'owner') on conflict do nothing`,
      [MEMBER, TEAM, STRANGER, OTHER_TEAM],
    );

    await client.query(
      `insert into user_invites (team_id, email, role)
       values ($1, $2, 'member')`,
      [TEAM, INVITEE_EMAIL],
    );

    await client.query(
      `insert into apps (id, team_id, app_id, created_by)
       values ($1, $2, 'slack', $3), ($4, $5, 'slack', $6)`,
      [
        "eeeeeeee-1000-0000-0000-000000000001",
        TEAM,
        MEMBER,
        "eeeeeeee-1000-0000-0000-000000000002",
        OTHER_TEAM,
        STRANGER,
      ],
    );

    await client.query(
      `insert into bank_accounts (id, team_id, created_by, account_id, name)
       values ($1, $2, $3, 'acc-1', 'Ours'), ($4, $5, $6, 'acc-2', 'Theirs')`,
      [
        "eeeeeeee-2000-0000-0000-000000000001",
        TEAM,
        MEMBER,
        "eeeeeeee-2000-0000-0000-000000000002",
        OTHER_TEAM,
        STRANGER,
      ],
    );

    await client.query(
      `insert into tracker_entries (id, team_id, description)
       values ($1, $2, 'before')`,
      ["eeeeeeee-3000-0000-0000-000000000001", TEAM],
    );

    await client.query(
      `insert into insights (id, team_id, period_type, period_start, period_end,
                             period_year, period_number, currency)
       values ($1, $2, 'monthly', '2026-01-01', '2026-01-31', 2026, 1, 'EUR')`,
      ["eeeeeeee-4000-0000-0000-000000000001", TEAM],
    );
    await client.query(
      `insert into insight_user_status (insight_id, user_id)
       values ($1, $2), ($1, $3)`,
      ["eeeeeeee-4000-0000-0000-000000000001", MEMBER, STRANGER],
    );
  });

  afterAll(async () => {
    await cleanup();
    await client.end();
  });

  test("a member reads only their own team's membership rows", async () => {
    // The one place the restoration deliberately diverges from the dump.
    // Production's policy was USING (true): every authenticated user could
    // read every membership row in the database, including which people are
    // on which other team.
    const seen = await asRole(client, { id: MEMBER }, () =>
      ids("select team_id as id from users_on_team"),
    );

    expect(seen).toEqual([TEAM]);
  });

  test("a member reads their own team and not another", async () => {
    const seen = await asRole(client, { id: MEMBER }, () =>
      ids("select id from teams"),
    );

    expect(seen).toEqual([TEAM]);
  });

  test("an invited user can see the team before joining it", async () => {
    // Reaches private.get_invites_for_authenticated_user(), which the
    // bootstrap did not have until this change — creating the policy would
    // have failed outright without it.
    const seen = await asRole(
      client,
      { id: INVITEE, email: INVITEE_EMAIL },
      () => ids("select id from teams"),
    );

    expect(seen).toEqual([TEAM]);
  });

  test("team-scoped tables are readable by their own team only", async () => {
    for (const table of ["apps", "bank_accounts"]) {
      const mine = await asRole(client, { id: MEMBER }, () =>
        ids(`select team_id as id from ${table}`),
      );
      const theirs = await asRole(client, { id: STRANGER }, () =>
        ids(`select team_id as id from ${table}`),
      );

      expect(mine).toEqual([TEAM]);
      expect(theirs).toEqual([OTHER_TEAM]);
    }
  });

  test("a member can update their own team's tracker entry", async () => {
    // The dump put the team expression in WITH CHECK and left USING out, which
    // makes no row selectable for update: verbatim, this policy updated zero
    // rows. The USING is the completion.
    const updated = await asRole(client, { id: MEMBER }, async () => {
      const { rowCount } = await client.query(
        "update tracker_entries set description = 'after' where team_id = $1",
        [TEAM],
      );
      return rowCount;
    });

    expect(updated).toBe(1);
  });

  test("a stranger cannot update another team's tracker entry", async () => {
    const updated = await asRole(client, { id: STRANGER }, async () => {
      const { rowCount } = await client.query(
        "update tracker_entries set description = 'stolen' where team_id = $1",
        [TEAM],
      );
      return rowCount;
    });

    expect(updated).toBe(0);
  });

  test("a user manages only their own insight status", async () => {
    const mine = await asRole(client, { id: MEMBER }, () =>
      ids("select user_id as id from insight_user_status"),
    );

    expect(mine).toEqual([MEMBER]);
  });

  test("anon reads none of it", async () => {
    for (const table of ["teams", "users_on_team", "apps", "bank_accounts"]) {
      const seen = await asRole(client, null, () =>
        ids(`select id from ${table}`),
      );

      expect(seen).toEqual([]);
    }
  });
});
