/**
 * Seam under test: a SQL file from packages/db/supabase applied to a database.
 * Behaviour is observed through the queries the application runs, not through
 * the catalog, except where the catalog *is* the requirement (an extension or
 * a security-definer flag).
 *
 * Needs the throwaway Postgres from docker-compose.test.yml:
 *   docker compose -f docker-compose.test.yml up -d
 *   bun run test:e2e:setup          # once; the second describe needs the pushed schema
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/midday_test bun test src/test/supabase-sql.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Client } from "pg";
import { applySqlFiles } from "../scripts/apply-sql";
import { PUBLISHED_TABLES } from "../scripts/realtime-tables";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_DATABASE_URL;

const SUPABASE_DIR = resolve(__dirname, "../../supabase");
const BOOTSTRAP_SQL = resolve(SUPABASE_DIR, "00-bootstrap.sql");

/**
 * Runs fn with the database role and JWT claim a request would carry, inside a
 * transaction that is rolled back afterwards. Pass no user to act as `anon`.
 */
async function asRole<T>(
  client: Client,
  userId: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query("begin");
  try {
    await client.query(
      userId ? "set local role authenticated" : "set local role anon",
    );
    if (userId) {
      await client.query(
        "select set_config('request.jwt.claim.sub', $1, true)",
        [userId],
      );
    }
    return await fn();
  } finally {
    await client.query("rollback");
  }
}

describe.skipIf(SKIP)("supabase/00-bootstrap.sql", () => {
  let client: Client;

  beforeAll(async () => {
    // Twice on purpose: the bootstrap script must be safe to re-run.
    await applySqlFiles(TEST_DATABASE_URL!, [BOOTSTRAP_SQL]);
    await applySqlFiles(TEST_DATABASE_URL!, [BOOTSTRAP_SQL]);

    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  test("installs the extensions schema.ts depends on", async () => {
    const { rows } = await client.query<{ extname: string }>(
      "select extname from pg_extension where extname in ('vector', 'pg_trgm') order by extname",
    );

    expect(rows.map((row) => row.extname)).toEqual(["pg_trgm", "vector"]);
  });

  test("defines the team lookup every RLS policy calls, as security definer", async () => {
    const { rows } = await client.query<{ prosecdef: boolean }>(
      `select p.prosecdef
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private'
          and p.proname = 'get_teams_for_authenticated_user'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.prosecdef).toBe(true);
  });

  test("an inbox search finds an item by sender and by product name", async () => {
    const { rows } = await client.query<{ matches: boolean }>(
      `select generate_inbox_fts(
                'Acme Hosting',
                extract_product_names('["Widget", "Gadget Pro"]'::json)
              ) @@ to_tsquery('english', 'acme & widget & gadget') as matches`,
    );

    expect(rows[0]!.matches).toBe(true);
  });

  test("gives every team a different inbox address", async () => {
    // teams.inbox_id defaults to a call into this and is UNIQUE. If the
    // function is missing, or the default is a literal rather than a call,
    // the project takes exactly one team.
    const { rows } = await client.query<{ a: string; b: string }>(
      "select generate_inbox(10) as a, generate_inbox(10) as b",
    );

    expect(rows[0]!.a).toHaveLength(10);
    expect(rows[0]!.a).not.toBe(rows[0]!.b);
  });

  test("gives every invite an unguessable code", async () => {
    const { rows } = await client.query<{ a: string; b: string }>(
      "select nanoid(24) as a, nanoid(24) as b",
    );

    expect(rows[0]!.a).toHaveLength(24);
    expect(rows[0]!.a).not.toBe(rows[0]!.b);
  });

  test("the generated inbox.fts column stays non-null without sender or products", async () => {
    const { rows } = await client.query<{ present: boolean }>(
      "select generate_inbox_fts(null, extract_product_names(null)) is not null as present",
    );

    expect(rows[0]!.present).toBe(true);
  });
});

/**
 * What `drizzle-kit push` left behind. Requires `bun run test:e2e:setup`,
 * like the other tests that read a prepared database.
 */
describe.skipIf(SKIP)("drizzle-kit push", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  test("creates no public table named after Supabase's auth.users", async () => {
    const { rows } = await client.query(
      "select tablename from pg_tables where schemaname = 'public' and tablename = 'auth.users'",
    );

    expect(rows).toEqual([]);
  });

  test("leaves Supabase's own auth.users alone", async () => {
    // The stub in setup-test-db.sql has exactly one column. Anything more
    // means push tried to manage a table Supabase owns.
    const { rows } = await client.query<{ n: number }>(
      `select count(*)::int as n
         from information_schema.columns
        where table_schema = 'auth' and table_name = 'users'`,
    );

    expect(rows[0]!.n).toBe(1);
  });

  test("ties an app user to the authenticated user it belongs to", async () => {
    const { rows } = await client.query<{ refs: string; ondelete: string }>(
      `select confrelid::regclass::text as refs, confdeltype as ondelete
         from pg_constraint where conname = 'users_id_fkey'`,
    );

    expect(rows[0]).toEqual({ refs: "auth.users", ondelete: "c" });
  });

  test("deleting the authenticated user takes the app user with it", async () => {
    const id = "00000000-0000-0000-0000-0000000f1392";
    await client.query("insert into auth.users (id) values ($1)", [id]);
    await client.query(
      "insert into users (id, email) values ($1, 'ff1392@example.test')",
      [id],
    );

    await client.query("delete from auth.users where id = $1", [id]);

    const { rows } = await client.query("select id from users where id = $1", [
      id,
    ]);
    expect(rows).toEqual([]);
  });

  test("gives each team its own inbox address, so a second team can exist", async () => {
    // inbox_id is UNIQUE and defaults to generate_inbox(10). Pushed from a
    // quoted default it was the literal string for every row, so the second
    // team ever created collided. createTeam does not set it.
    const ids: string[] = [];
    for (const name of ["FF-1392 One", "FF-1392 Two"]) {
      const { rows } = await client.query<{ inbox_id: string }>(
        "insert into teams (name) values ($1) returning inbox_id",
        [name],
      );
      ids.push(rows[0]!.inbox_id);
    }

    expect(ids[0]).not.toBe(ids[1]);
    await client.query("delete from teams where name like 'FF-1392 %'");
  });

  test("stores inbox.fts as a generated column, so a search needs no backfill", async () => {
    const { rows } = await client.query<{ is_generated: string }>(
      `select is_generated
         from information_schema.columns
        where table_name = 'inbox' and column_name = 'fts'`,
    );

    expect(rows[0]!.is_generated).toBe("ALWAYS");
  });
});

/**
 * The bucket policies from supabase/10-storage.sql, exercised as the roles
 * they are written for. Each case runs inside a transaction that sets the
 * role and the JWT claim Supabase's auth.uid() reads, then rolls back.
 */
describe.skipIf(SKIP)("supabase/10-storage.sql", () => {
  let client: Client;

  const TEAM_A = "aaaaaaaa-0000-0000-0000-000000000001";
  const TEAM_B = "bbbbbbbb-0000-0000-0000-000000000002";
  const MEMBER_OF_A = "cccccccc-0000-0000-0000-000000000003";

  beforeAll(async () => {
    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();

    await client.query(
      "insert into auth.users (id) values ($1) on conflict do nothing",
      [MEMBER_OF_A],
    );
    await client.query(
      "insert into teams (id, name) values ($1, 'Team A'), ($2, 'Team B') on conflict do nothing",
      [TEAM_A, TEAM_B],
    );
    await client.query(
      "insert into users (id, email) values ($1, 'member-a@example.test') on conflict do nothing",
      [MEMBER_OF_A],
    );
    await client.query(
      "insert into users_on_team (user_id, team_id, role) values ($1, $2, 'owner') on conflict do nothing",
      [MEMBER_OF_A, TEAM_A],
    );
  });

  afterAll(async () => {
    await client.query("delete from users_on_team where user_id = $1", [
      MEMBER_OF_A,
    ]);
    await client.query("delete from users where id = $1", [MEMBER_OF_A]);
    await client.query("delete from teams where id in ($1, $2)", [
      TEAM_A,
      TEAM_B,
    ]);
    await client.query("delete from auth.users where id = $1", [MEMBER_OF_A]);
    await client.end();
  });

  test("creates the three buckets, with only vault private", async () => {
    const { rows } = await client.query<{ id: string; public: boolean }>(
      "select id, public from storage.buckets order by id",
    );

    expect(rows).toEqual([
      { id: "apps", public: true },
      { id: "avatars", public: true },
      { id: "vault", public: false },
    ]);
  });

  test("a team member can upload into their own team's vault folder", async () => {
    await asRole(client, MEMBER_OF_A, async () => {
      const { rowCount } = await client.query(
        "insert into storage.objects (bucket_id, name) values ('vault', $1)",
        [`${TEAM_A}/transactions/tx-1/receipt.pdf`],
      );
      expect(rowCount).toBe(1);
    });
  });

  test("a team member cannot upload into another team's vault folder", async () => {
    await asRole(client, MEMBER_OF_A, async () => {
      const attempt = client.query(
        "insert into storage.objects (bucket_id, name) values ('vault', $1)",
        [`${TEAM_B}/transactions/tx-1/receipt.pdf`],
      );
      await expect(attempt).rejects.toThrow(/row-level security/i);
    });
  });

  test("a team member cannot read another team's vault files", async () => {
    await client.query(
      "insert into storage.objects (bucket_id, name) values ('vault', $1)",
      [`${TEAM_B}/secret.pdf`],
    );

    const visible = await asRole(client, MEMBER_OF_A, async () => {
      const { rows } = await client.query(
        "select name from storage.objects where bucket_id = 'vault'",
      );
      return rows.map((r) => r.name);
    });

    expect(visible).not.toContain(`${TEAM_B}/secret.pdf`);

    await client.query("delete from storage.objects where name = $1", [
      `${TEAM_B}/secret.pdf`,
    ]);
  });

  test("a user can upload an avatar into their own folder", async () => {
    await asRole(client, MEMBER_OF_A, async () => {
      const { rowCount } = await client.query(
        "insert into storage.objects (bucket_id, name) values ('avatars', $1)",
        [`${MEMBER_OF_A}/me.png`],
      );
      expect(rowCount).toBe(1);
    });
  });

  test("a user cannot upload an avatar into someone else's folder", async () => {
    await asRole(client, MEMBER_OF_A, async () => {
      const attempt = client.query(
        "insert into storage.objects (bucket_id, name) values ('avatars', $1)",
        [`${TEAM_B}/logo.png`],
      );
      await expect(attempt).rejects.toThrow(/row-level security/i);
    });
  });

  test("app images go under logos or screenshots, and nowhere else", async () => {
    await asRole(client, MEMBER_OF_A, async () => {
      const { rowCount } = await client.query(
        "insert into storage.objects (bucket_id, name) values ('apps', 'logos/abc.png')",
      );
      expect(rowCount).toBe(1);

      const attempt = client.query(
        "insert into storage.objects (bucket_id, name) values ('apps', 'elsewhere/abc.png')",
      );
      await expect(attempt).rejects.toThrow(/row-level security/i);
    });
  });

  test("app images are listable without signing in", async () => {
    await client.query(
      "insert into storage.objects (bucket_id, name) values ('apps', 'logos/public.png')",
    );

    const visible = await asRole(client, null, async () => {
      const { rows } = await client.query(
        "select name from storage.objects where bucket_id = 'apps'",
      );
      return rows;
    });

    expect(visible.map((r) => r.name)).toContain("logos/public.png");

    await client.query(
      "delete from storage.objects where name = 'logos/public.png'",
    );
  });

  test("an avatar is readable by its team and not by a stranger", async () => {
    // The bucket is public, so the image itself is served by unsigned URL
    // without consulting these policies. What this stops is one signed-in
    // user listing every other team's files.
    await client.query(
      "insert into storage.objects (bucket_id, name) values ('avatars', $1)",
      [`${TEAM_A}/logo.png`],
    );

    const asMember = await asRole(client, MEMBER_OF_A, async () => {
      const { rows } = await client.query(
        "select name from storage.objects where bucket_id = 'avatars'",
      );
      return rows.map((r) => r.name);
    });
    expect(asMember).toContain(`${TEAM_A}/logo.png`);

    const asStranger = await asRole(client, null, async () => {
      const { rows } = await client.query(
        "select name from storage.objects where bucket_id = 'avatars'",
      );
      return rows.map((r) => r.name);
    });
    expect(asStranger).toEqual([]);

    await client.query("delete from storage.objects where name = $1", [
      `${TEAM_A}/logo.png`,
    ]);
  });
});

/**
 * supabase/20-realtime.sql. A subscription to a table outside the
 * supabase_realtime publication never errors — it just stays quiet — and
 * realtime only delivers rows the subscriber is allowed to select, so both
 * halves are checked here.
 */
describe.skipIf(SKIP)("supabase/20-realtime.sql", () => {
  let client: Client;

  const TEAM = "dddddddd-0000-0000-0000-000000000001";
  const OWNER = "dddddddd-0000-0000-0000-000000000002";
  const OTHER = "dddddddd-0000-0000-0000-000000000003";

  beforeAll(async () => {
    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();

    for (const id of [OWNER, OTHER]) {
      await client.query(
        "insert into auth.users (id) values ($1) on conflict do nothing",
        [id],
      );
      await client.query(
        "insert into users (id, email) values ($1, $2) on conflict do nothing",
        [id, `${id}@example.test`],
      );
    }
    await client.query(
      "insert into teams (id, name) values ($1, 'Realtime Team') on conflict do nothing",
      [TEAM],
    );

    for (const id of [OWNER, OTHER]) {
      await client.query(
        `insert into activities (team_id, user_id, type, source, metadata)
         values ($1, $2, 'transactions_created', 'system', '{}'::jsonb)`,
        [TEAM, id],
      );
    }
  });

  afterAll(async () => {
    await client.query("delete from activities where team_id = $1", [TEAM]);
    await client.query("delete from users where id in ($1, $2)", [
      OWNER,
      OTHER,
    ]);
    await client.query("delete from teams where id = $1", [TEAM]);
    await client.query("delete from auth.users where id in ($1, $2)", [
      OWNER,
      OTHER,
    ]);
    await client.end();
  });

  test("publishes every table the dashboard subscribes to", async () => {
    const { rows } = await client.query<{ tablename: string }>(
      `select tablename from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public'
        order by tablename`,
    );

    expect(rows.map((r) => r.tablename)).toEqual([...PUBLISHED_TABLES]);
  });

  test("a team member reads their team's transactions and not another team's", async () => {
    // The end of the chain this epic builds: the policy expression is
    // restored in schema.ts (it had been lost), push drops it, and the
    // bootstrap's policy step puts it back. If any link breaks, a subscriber
    // either sees nothing or sees everyone's.
    const OTHER_TEAM = "dddddddd-0000-0000-0000-00000000000f";
    await client.query(
      "insert into teams (id, name) values ($1, 'Other Team') on conflict do nothing",
      [OTHER_TEAM],
    );
    await client.query(
      `insert into users_on_team (user_id, team_id, role)
       values ($1, $2, 'owner') on conflict do nothing`,
      [OWNER, TEAM],
    );
    for (const [team, name] of [
      [TEAM, "Ours"],
      [OTHER_TEAM, "Theirs"],
    ] as const) {
      await client.query(
        `insert into transactions (team_id, date, name, method, amount, currency, internal_id)
         values ($1, '2026-01-01', $2, 'payment', 1, 'EUR', $3)`,
        [team, name, `ff1395-${name}`],
      );
    }

    const visible = await asRole(client, OWNER, async () => {
      const { rows } = await client.query<{ name: string }>(
        "select name from transactions where internal_id like 'ff1395-%'",
      );
      return rows.map((r) => r.name);
    });

    expect(visible).toEqual(["Ours"]);

    await client.query(
      "delete from transactions where internal_id like 'ff1395-%'",
    );
    await client.query("delete from users_on_team where user_id = $1", [OWNER]);
    await client.query("delete from teams where id = $1", [OTHER_TEAM]);
  });

  test("a user is notified of their own activities and not someone else's", async () => {
    const visible = await asRole(client, OWNER, async () => {
      const { rows } = await client.query<{ user_id: string }>(
        "select user_id from activities where team_id = $1",
        [TEAM],
      );
      return rows.map((r) => r.user_id);
    });

    expect(visible).toEqual([OWNER]);
  });
});
