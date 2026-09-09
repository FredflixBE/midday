/**
 * The journal is what `db:migrate` reads, and a journal that disagrees with
 * the files beside it is what made `db:migrate` exit 1 without a message for
 * months: it named `0000_silly_sage`, no such file existed, and the 39
 * migrations that did exist were listed nowhere.
 *
 * drizzle-kit writes the journal, so these are not assertions about our code
 * so much as a tripwire on the directory — the failure mode is a file added,
 * renamed or removed by hand.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  MIGRATIONS_DIR,
  migrationHash,
  readJournal,
} from "../scripts/migrations";

const entries = readJournal();

const sqlFiles = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort();

describe("the migration journal", () => {
  test("names at least one migration", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  test("every entry has the file it names", () => {
    // migrationHash reads the file, so it throws when there is none. This is
    // the original defect, stated as a test.
    for (const entry of entries) {
      expect(() => migrationHash(entry.tag)).not.toThrow();
    }
  });

  test("every migration file is in the journal", () => {
    // The other half of it: 39 real .sql files that migrate never applied and
    // never mentioned. History lives in migrations/archive, which is not read.
    const listed = entries.map((entry) => `${entry.tag}.sql`).sort();

    expect(sqlFiles).toEqual(listed);
  });

  test("entries run forwards in time", () => {
    // The migrator applies everything newer than the newest applied row, so
    // an out-of-order `when` is a migration that silently never runs.
    const times = entries.map((entry) => entry.when);

    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(times).size).toBe(times.length);
  });

  test("indexes are 0, 1, 2 … in order", () => {
    expect(entries.map((entry) => entry.idx)).toEqual(entries.map((_, i) => i));
  });
});

describe("the archived migrations", () => {
  test("are still there, and out of the journal's way", () => {
    // They predate the base migration and are superseded by it. Kept so the
    // history of what upstream changed stays readable in the tree; drizzle
    // never looks in a subdirectory.
    const archived = readdirSync(resolve(MIGRATIONS_DIR, "archive")).filter(
      (name) => name.endsWith(".sql"),
    );

    expect(archived.length).toBe(39);
  });
});
