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

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_DATABASE_URL;

const SUPABASE_DIR = resolve(__dirname, "../../supabase");
const BOOTSTRAP_SQL = resolve(SUPABASE_DIR, "00-bootstrap.sql");

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
