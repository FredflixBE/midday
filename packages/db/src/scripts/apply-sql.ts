/**
 * Apply SQL files to a database, in order, each file as one multi-statement
 * query. Replaces `psql -f` so the test setup and the Supabase bootstrap work
 * from a plain `bun install`, without a Postgres client on the machine.
 *
 * CLI:
 *   bun run src/scripts/apply-sql.ts <file.sql> [more.sql ...]
 * Applies to the test database — see resolveTestConnection().
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";

const LOCAL_TEST_DATABASE_URL =
  "postgres://postgres:postgres@localhost:5433/midday_test";

/**
 * Which database the helper scripts act on: the test one, and only ever that.
 *
 * DATABASE_SESSION_POOLER is deliberately NOT consulted here. `bun run` loads
 * `packages/db/.env`, which sets it to the real Supabase project — so a
 * fallback to it turns "apply this file" into "apply this file to production"
 * for anyone who has not exported TEST_DATABASE_URL. bootstrap.ts is the only
 * script that reaches a real project, and it requires that variable to be
 * passed to it deliberately.
 */
export function resolveTestConnection(): string {
  return process.env.TEST_DATABASE_URL ?? LOCAL_TEST_DATABASE_URL;
}

/**
 * Whether a connection string names a database on this machine.
 *
 * The host is compared exactly, and read with a URL parser rather than matched
 * in the string. Matching on `@localhost` is what this used to do, and it is
 * wrong in both directions: userinfo ends at the *last* `@`, so
 * `postgres://u:pw@localhost:@prod.example.com/proddb` contains `@localhost:`
 * while pointing at prod.example.com — and a credential-free
 * `postgres://localhost:5433/midday_test` contains no `@` at all and was
 * refused. Scripts that drop databases decide on this answer, so it is one
 * function and not a regex in three files.
 */
export function isLocalDatabase(connectionString: string): boolean {
  try {
    const { hostname } = new URL(connectionString);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    // Not parseable is not local. Whatever it is, nothing here should act on
    // it.
    return false;
  }
}

/** The same connection string, pointed at another database on that server. */
export function pointAt(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

/** Which database a connection string names, with no leading slash. */
export function databaseName(connectionString: string): string {
  return new URL(connectionString).pathname.replace(/^\//, "");
}

/**
 * Supabase's pooler needs TLS; a local container does not offer it.
 *
 * `rejectUnauthorized: false` matches how the app connects (src/client.ts):
 * the pooler presents a certificate these scripts have no root for, and the
 * alternative is shipping Supabase's CA around. It is the same trade already
 * made for every query the API runs.
 */
export function sslFor(connectionString: string) {
  return isLocalDatabase(connectionString)
    ? undefined
    : {
        rejectUnauthorized: false,
      };
}

/** Applies one file over an already-open connection. */
export async function applySqlFile(client: Client, path: string) {
  await client.query(await readFile(path, "utf8"));
}

export async function applySqlFiles(
  connectionString: string,
  files: string[],
  log: (line: string) => void = () => {},
): Promise<void> {
  const client = new Client({
    connectionString,
    ssl: sslFor(connectionString),
  });
  await client.connect();

  try {
    for (const file of files) {
      const path = resolve(file);
      await applySqlFile(client, path);
      log(`applied ${path}`);
    }
  } finally {
    await client.end();
  }
}

// This package compiles as CommonJS (no "type": "module"), which is why the
// one other script using `import.meta` needs a @ts-expect-error to do it.
// `require.main` is the entry-point check that typechecks here.
if (require.main === module) {
  const files = process.argv.slice(2);

  if (files.length === 0) {
    console.error("usage: apply-sql.ts <file.sql> [more.sql ...]");
    process.exit(2);
  }

  applySqlFiles(resolveTestConnection(), files, console.log).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
