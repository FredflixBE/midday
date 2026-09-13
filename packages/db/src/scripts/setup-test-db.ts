/**
 * `bun run test:e2e:setup` — build the test database from nothing, and say so
 * when it did not work.
 *
 * This replaces a shell `&&` chain whose second step, `drizzle-kit push`,
 * exits 0 after failing (FF-1559). Against a test database that already had
 * content, push found policies carrying the expressions the policy step had
 * filled in — which its own reading of `schema.ts` does not have — and stopped
 * to ask whether they had been renamed. There is no terminal to answer that,
 * so it threw; and then exited 0 anyway. The chain carried on, the policies
 * and the Supabase SQL applied over the *old* schema, and the run ended
 * looking successful. The next test run failed on a column that is plainly in
 * `schema.ts` and in a committed migration, two steps away from the cause.
 *
 * Two things stop that happening again:
 *
 *   - **The database is dropped and recreated first**, so push has an empty
 *     target and nothing to ask about. This is what a fresh CI container gives
 *     it already, which is why CI never hit this.
 *   - **The schema is checked afterwards**, table by table and column by
 *     column, against `schema.ts`. Push's exit code is checked too, but it is
 *     not trusted on its own — see above, and see the same note on
 *     bootstrap.ts, which learned it separately.
 *
 * It only ever touches the test database. Like every other script here it
 * reads TEST_DATABASE_URL and nothing else — never DATABASE_SESSION_POOLER,
 * which `bun run` loads from packages/db/.env pointing at the real project.
 * Because this one issues DROP DATABASE it also refuses to run unless that URL
 * names a local container, the same second guard verify-migrations.ts has.
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { Client } from "pg";
import { applyPolicies } from "./apply-policies";
import { applySqlFile, resolveTestConnection, sslFor } from "./apply-sql";
import { describeMissing, missingSchemaObjects } from "./schema-check";

const PACKAGE_ROOT = resolve(__dirname, "../..");

/** Applied before the push: what push needs to already exist. */
const BEFORE = [
  // inbox.fts is a stored column calling generate_inbox_fts, so the function
  // has to exist before the table does.
  "supabase/00-bootstrap.sql",
  // The roles the policies are granted to, which Supabase supplies and a
  // vanilla Postgres does not. After 00-bootstrap.sql on purpose — see the
  // file's own comment.
  "src/test/helpers/setup-test-db.sql",
];

/** Applied after the push and the policies, in this order. */
const AFTER = [
  "supabase/10-storage.sql",
  "supabase/11-storage-policies.sql",
  "supabase/20-realtime.sql",
  "supabase/30-auth-user.sql",
  "supabase/40-functions.sql",
  "supabase/50-documents.sql",
  "supabase/51-document-triggers.sql",
];

/** The same connection string, pointed at another database on that server. */
function pointAt(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

function databaseName(connectionString: string): string {
  return new URL(connectionString).pathname.replace(/^\//, "");
}

function runPush(url: string): Promise<number> {
  return new Promise((done, fail) => {
    const child = spawn(
      "bunx",
      ["drizzle-kit", "push", "--config=drizzle.config.test.ts", "--force"],
      {
        cwd: PACKAGE_ROOT,
        stdio: ["inherit", "inherit", "inherit"],
        // The config reads TEST_DATABASE_URL, and the child's env wins over
        // packages/db/.env — so push reaches the database this script just
        // made and never anything else.
        env: { ...process.env, TEST_DATABASE_URL: url },
      },
    );
    child.on("error", fail);
    child.on("close", (code) => done(code ?? 1));
  });
}

/** Drops and recreates the test database, so push starts from empty. */
async function recreate(url: string, name: string): Promise<void> {
  const admin = new Client({
    connectionString: pointAt(url, "postgres"),
    ssl: sslFor(url),
  });
  await admin.connect();

  try {
    // FORCE closes whatever is still connected — a previous test run's pool,
    // usually. Postgres 13 and up; the test container is 16.
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.query(`create database ${name}`);
  } finally {
    await admin.end();
  }
}

/** Returns the process exit code. */
async function main(): Promise<number> {
  const url = resolveTestConnection();
  const name = databaseName(url);

  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
    console.error(
      "TEST_DATABASE_URL does not point at localhost. This script drops and",
    );
    console.error(
      "recreates the database it names, so it only runs against the test",
    );
    console.error("container. Nothing has been changed.");
    return 2;
  }

  if (name === "postgres" || name === "") {
    console.error(
      `TEST_DATABASE_URL names the database "${name || "(none)"}", which is the`,
    );
    console.error(
      "one this script connects to in order to drop the other. Point it at a",
    );
    console.error("database of its own. Nothing has been changed.");
    return 2;
  }

  console.log(`1. recreating ${name}`);
  await recreate(url, name);

  const client = new Client({ connectionString: url, ssl: sslFor(url) });
  await client.connect();

  try {
    console.log(
      "2. functions, extensions and the roles policies are granted to",
    );
    for (const file of BEFORE) {
      await applySqlFile(client, resolve(PACKAGE_ROOT, file));
      console.log(`  applied ${file}`);
    }

    console.log("3. tables, columns and indexes (drizzle-kit push)");
    const code = await runPush(url);
    if (code !== 0) {
      console.error(`\ndrizzle-kit push exited ${code}. Nothing else was run.`);
      return 1;
    }

    // The real gate, and it comes straight after the push rather than at the
    // end: push exiting 0 says nothing about whether it did anything, and
    // every step below assumes the tables are there. Left to last, a push that
    // did nothing surfaces as `relation "transactions" does not exist` from
    // the policy step — loud, but about the wrong thing.
    console.log("4. checking the schema landed");
    const missing = await missingSchemaObjects(client);

    if (missing.length > 0) {
      console.error(
        `\n${missing.length} thing${missing.length === 1 ? "" : "s"} in schema.ts did not reach the database:`,
      );
      for (const line of describeMissing(missing)) {
        console.error(`  ${line}`);
      }
      console.error("");
      console.error(
        "The test database is NOT ready. Running the suite now would fail on",
      );
      console.error(
        "whichever of these it reached first, which is the confusion this",
      );
      console.error("check exists to prevent.");
      return 1;
    }

    console.log("  schema.ts is fully applied");

    console.log("5. row level security policies, from schema.ts");
    const applied = await applyPolicies(client);
    console.log(`  applied ${applied} policies`);

    console.log("6. storage, realtime, auth and the runtime functions");
    for (const file of AFTER) {
      await applySqlFile(client, resolve(PACKAGE_ROOT, file));
      console.log(`  applied ${file}`);
    }

    console.log(`\n${name} is ready.`);
    return 0;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
