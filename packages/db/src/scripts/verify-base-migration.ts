/**
 * `bun run verify:migrations` — build a database from the migration files
 * alone, and check it landed where the bootstrap lands.
 *
 * The bootstrap builds a fresh project from `schema.ts` with `drizzle-kit
 * push` and never reads a migration file, so nothing else exercises them. A
 * base migration that no longer applies would sit there looking fine, and the
 * first person to find out would be whoever needed `db:migrate` against the
 * running project — the one moment when there is no fallback.
 *
 * Creates a scratch database beside the test one, and drops it afterwards.
 * Refuses to touch anything but the test server: it only ever reads
 * TEST_DATABASE_URL, like every other script here, and refuses outright if
 * that points anywhere but a local container — this is the one script in the
 * package that issues DROP DATABASE, so "only ever reads the right variable"
 * is not a strong enough guard on its own.
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { Client } from "pg";
import { applySqlFile, resolveTestConnection, sslFor } from "./apply-sql";
import { readJournal } from "./migrations";

const PACKAGE_ROOT = resolve(__dirname, "../..");
const SCRATCH = "midday_base_migration_check";

/** The same connection string, pointed at another database on that server. */
function pointAt(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

function runMigrate(url: string): Promise<number> {
  return new Promise((done, fail) => {
    const child = spawn("bunx", ["drizzle-kit", "migrate"], {
      cwd: PACKAGE_ROOT,
      stdio: ["inherit", "inherit", "inherit"],
      env: { ...process.env, DATABASE_SESSION_POOLER: url },
    });
    child.on("error", fail);
    child.on("close", (code) => done(code ?? 1));
  });
}

async function main(): Promise<number> {
  const test = resolveTestConnection();

  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(test)) {
    console.error(
      "TEST_DATABASE_URL does not point at localhost. This script creates and",
    );
    console.error(
      "drops a database, so it only runs against the test container. Nothing",
    );
    console.error("has been changed.");
    return 2;
  }

  const admin = new Client({
    connectionString: pointAt(test, "postgres"),
    ssl: sslFor(test),
  });
  await admin.connect();

  try {
    await admin.query(`drop database if exists ${SCRATCH}`);
    await admin.query(`create database ${SCRATCH}`);
  } finally {
    await admin.end();
  }

  const url = pointAt(test, SCRATCH);
  const client = new Client({ connectionString: url, ssl: sslFor(url) });
  await client.connect();

  const problems: string[] = [];

  try {
    // What Supabase supplies and a vanilla Postgres does not, then the
    // functions the schema's own defaults and generated columns call. Both are
    // outside the migrations by design — they are Supabase's half of the
    // database, and a real project already has the first one.
    await applySqlFile(
      client,
      resolve(PACKAGE_ROOT, "src/test/helpers/setup-test-db.sql"),
    );
    await applySqlFile(
      client,
      resolve(PACKAGE_ROOT, "supabase/00-bootstrap.sql"),
    );

    const code = await runMigrate(url);
    if (code !== 0) problems.push(`drizzle-kit migrate exited ${code}`);

    const { rows: tables } = await client.query<{ n: string }>(
      "select count(*)::text as n from pg_tables where schemaname = 'public'",
    );
    if (Number(tables[0]?.n) === 0) {
      problems.push("the migrations created no tables in public");
    }

    // The reason a base migration is worth having: `generate` emits every
    // policy with its expression, which `push` does not.
    const { rows: toothless } = await client.query<{ n: string }>(
      `select count(*)::text as n from pg_policies
        where schemaname = 'public' and qual is null and with_check is null`,
    );
    if (Number(toothless[0]?.n) > 0) {
      problems.push(
        `${toothless[0]?.n} policies arrived without an expression`,
      );
    }

    const { rows: applied } = await client.query<{ n: string }>(
      "select count(*)::text as n from drizzle.__drizzle_migrations",
    );
    const expected = readJournal().length;
    if (Number(applied[0]?.n) !== expected) {
      problems.push(
        `${applied[0]?.n} migrations recorded, journal has ${expected}`,
      );
    }

    console.log(
      `${tables[0]?.n} tables, ${applied[0]?.n} migrations recorded, ${toothless[0]?.n} policies without an expression`,
    );
  } finally {
    await client.end();

    const cleanup = new Client({
      connectionString: pointAt(test, "postgres"),
      ssl: sslFor(test),
    });
    await cleanup.connect();
    await cleanup.query(`drop database if exists ${SCRATCH}`);
    await cleanup.end();
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`FAIL  ${problem}`);
    return 1;
  }

  console.log("A database built from the migration files alone is complete.");
  return 0;
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
