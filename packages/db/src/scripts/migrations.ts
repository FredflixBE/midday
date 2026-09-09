/**
 * The migration journal, read the way drizzle reads it.
 *
 * `db:bootstrap` builds a project from `schema.ts` rather than by replaying
 * migrations, so it ends up at the state the whole journal describes without
 * having run any of it. Something has to tell `db:migrate` that, or the next
 * run would try to CREATE TABLE over a schema that already has everything.
 *
 * The values here have to match `drizzle-orm`'s own migrator exactly, because
 * that is what reads the table afterwards (pg-core/dialect.js `migrate`):
 * a row per applied migration, `hash` the sha256 of the file's contents and
 * `created_at` the journal's `when`. Only `created_at` decides what runs —
 * the migrator applies every migration whose `when` is greater than the
 * newest recorded one — so a wrong hash would not be caught by anything.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Client } from "pg";

export const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

export type JournalEntry = {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
};

type Journal = {
  version: string;
  dialect: string;
  entries: JournalEntry[];
};

export function readJournal(dir: string = MIGRATIONS_DIR): JournalEntry[] {
  const journal = JSON.parse(
    readFileSync(resolve(dir, "meta/_journal.json"), "utf8"),
  ) as Journal;

  return journal.entries;
}

/** The sha256 of the migration file, which is what drizzle records. */
export function migrationHash(
  tag: string,
  dir: string = MIGRATIONS_DIR,
): string {
  const sql = readFileSync(resolve(dir, `${tag}.sql`), "utf8");

  return createHash("sha256").update(sql).digest("hex");
}

/**
 * Records migrations as already applied, without running them — the whole
 * journal by default, or just the entries passed in. Returns how many rows it
 * added, so 0 when the table already knew.
 *
 * Safe to run twice: a migration is matched by its hash, so re-running adds
 * nothing, and a *changed* migration file would be recorded again rather than
 * silently treated as the old one.
 */
export async function stampMigrations(
  client: Client,
  options: { dir?: string; entries?: JournalEntry[] } = {},
): Promise<number> {
  const dir = options.dir ?? MIGRATIONS_DIR;
  const entries = options.entries ?? readJournal(dir);

  await client.query("create schema if not exists drizzle");
  await client.query(`create table if not exists drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )`);

  let stamped = 0;

  for (const entry of entries) {
    const { rowCount } = await client.query(
      `insert into drizzle.__drizzle_migrations (hash, created_at)
       select $1, $2
        where not exists (
              select 1 from drizzle.__drizzle_migrations where hash = $1)`,
      [migrationHash(entry.tag, dir), entry.when],
    );

    stamped += rowCount ?? 0;
  }

  return stamped;
}
