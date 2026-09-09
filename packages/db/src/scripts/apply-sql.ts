/**
 * Apply SQL files to a database, in order, each file as one multi-statement
 * query. Replaces `psql -f` so the test setup and the Supabase bootstrap work
 * from a plain `bun install`, without a Postgres client on the machine.
 *
 * CLI (test setup):
 *   bun run src/scripts/apply-sql.ts <file.sql> [more.sql ...]
 * Reads TEST_DATABASE_URL, defaulting to the docker-compose.test.yml instance.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";

const LOCAL_TEST_DATABASE_URL =
  "postgres://postgres:postgres@localhost:5433/midday_test";

/** Supabase's pooler needs TLS; a local container does not offer it. */
export function sslFor(connectionString: string) {
  return /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString)
    ? undefined
    : { rejectUnauthorized: false };
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
      const sql = await readFile(path, "utf8");
      await client.query(sql);
      log(`applied ${path}`);
    }
  } finally {
    await client.end();
  }
}

// This package compiles as CommonJS (no "type": "module"), so `import.meta`
// is unavailable; `require.main` is the entry-point check that typechecks.
if (require.main === module) {
  const files = process.argv.slice(2);

  if (files.length === 0) {
    console.error("usage: apply-sql.ts <file.sql> [more.sql ...]");
    process.exit(2);
  }

  const url = process.env.TEST_DATABASE_URL ?? LOCAL_TEST_DATABASE_URL;

  applySqlFiles(url, files, console.log).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
