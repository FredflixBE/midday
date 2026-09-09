/**
 * `bun run db:stamp --through <tag>` — tell an existing project which
 * migrations it already contains, without running them.
 *
 * `db:bootstrap` does this for a project it builds itself. This is for the
 * project that was built before it did — the schema is there, applied by an
 * earlier `drizzle-kit push`, but `drizzle.__drizzle_migrations` is empty, so
 * the first `db:migrate` would try to CREATE TABLE over all of it and fail.
 *
 * Which tag to name is the whole decision, and it is not guessable from here:
 * stamping past what the database actually contains skips a migration it
 * needs, silently and permanently. So there is no default. Run it with no
 * arguments first — it prints the journal, what is already recorded, and what
 * `db:migrate` would do next.
 *
 * For a project built by the FF-1369 bootstrap: it was pushed from a
 * schema.ts of that moment, which is the base migration and nothing after it.
 */

import { Client } from "pg";
import { sslFor } from "./apply-sql";
import { readJournal, stampMigrations } from "./migrations";

async function main(): Promise<number> {
  const url = process.env.DATABASE_SESSION_POOLER;

  if (!url) {
    console.error(
      "DATABASE_SESSION_POOLER is not set. It is the session pooler URL from",
    );
    console.error(
      "Supabase > Project Settings > Database. Nothing has been changed.",
    );
    return 2;
  }

  const flag = process.argv.indexOf("--through");
  const through = flag === -1 ? undefined : process.argv[flag + 1];
  const journal = readJournal();

  if (through && !journal.some((entry) => entry.tag === through)) {
    console.error(`No migration named ${through} in the journal.`);
    return 2;
  }

  const client = new Client({ connectionString: url, ssl: sslFor(url) });
  await client.connect();

  try {
    // Never print the URL: it carries the database password.
    const { rows: where } = await client.query<{ db: string; host: string }>(
      "select current_database() as db, coalesce(inet_server_addr()::text, 'local') as host",
    );
    console.log(`${where[0]?.db} at ${where[0]?.host}\n`);

    const { rows: recorded } = await client.query<{ n: string }>(
      `select count(*)::text as n from information_schema.tables
        where table_schema = 'drizzle' and table_name = '__drizzle_migrations'`,
    );
    const alreadyRecorded =
      Number(recorded[0]?.n) === 0
        ? 0
        : Number(
            (
              await client.query<{ n: string }>(
                "select count(*)::text as n from drizzle.__drizzle_migrations",
              )
            ).rows[0]?.n ?? 0,
          );

    console.log(`${alreadyRecorded} migration(s) already recorded.\n`);
    console.log("The journal:");
    for (const entry of journal) {
      console.log(`  ${entry.idx}  ${entry.tag}`);
    }
    console.log("");

    if (!through) {
      console.log(
        "Nothing has been changed. Re-run naming the last migration this",
      );
      console.log("database already contains, for example:");
      console.log(`  bun run db:stamp --through ${journal[0]?.tag}`);
      console.log("");
      console.log(
        "Everything after it stays pending, and db:migrate applies it.",
      );
      return 0;
    }

    const upTo = journal.slice(
      0,
      journal.findIndex((entry) => entry.tag === through) + 1,
    );
    const pending = journal.slice(upTo.length);

    const stamped = await stampMigrations(client, { entries: upTo });

    console.log(`Recorded ${stamped} migration(s) as already applied.`);
    console.log(
      pending.length === 0
        ? "db:migrate has nothing left to apply."
        : `db:migrate will now apply: ${pending.map((e) => e.tag).join(", ")}`,
    );

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
