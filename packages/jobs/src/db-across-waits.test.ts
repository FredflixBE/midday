import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * A database handle must not be held across a wait.
 *
 * `tasks.onWait` in `src/init.ts` closes the connection pool while a run is
 * suspended, and `tasks.onResume` puts a **new** one in locals. So a handle
 * taken with `const db = getDb()` before a `triggerAndWait` still points at the
 * pool that was ended, and the first query after the wait fails.
 *
 * It fails in a way that is easy to miss. Everything before the wait works, the
 * child task works, and only the code after the wait dies — so on FF-1517's
 * first live run the 151 card charges imported perfectly while every status
 * write and the settlement marking were lost, and the failure read like a
 * problem with the SQL rather than with the connection.
 *
 * The rule is therefore blunt on purpose: **a task that waits calls `getDb()`
 * at each use and never binds it.** Re-reading it is free, and no reviewer has
 * to trace whether a particular binding happens to be used after a particular
 * wait.
 */
const WAITS = /triggerAndWait|wait\.for|wait\.until|batchTriggerAndWait/;
const BINDS_DB = /(?:const|let)\s+\w+\s*=\s*(?:await\s+)?getDb\(\)/;

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });

  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);

      if (entry.isDirectory()) return sourceFiles(path);
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
        ? [path]
        : [];
    }),
  );

  return files.flat();
}

describe("the database handle across a wait", () => {
  test("no task that waits also binds getDb() to a variable", async () => {
    const offenders: string[] = [];

    for (const file of await sourceFiles(join(import.meta.dir, "tasks"))) {
      const source = await readFile(file, "utf8");

      if (WAITS.test(source) && BINDS_DB.test(source)) {
        offenders.push(file.slice(file.indexOf("/src/") + 1));
      }
    }

    expect(offenders).toEqual([
      // `process-document.ts` binds one, and its waits are in other methods
      // that never touch it. It is listed rather than fixed because changing
      // it is not this guard's business — but if a wait and that handle ever
      // meet, this line is where the next person will look.
      "src/tasks/document/process-document.ts",
    ]);
  });

  test("finds the things it claims to look for", async () => {
    // Both patterns matching nothing would make the list above pass by being
    // empty, which is the one way this guard can fail silently.
    const files = await sourceFiles(join(import.meta.dir, "tasks"));
    const sources = await Promise.all(files.map((f) => readFile(f, "utf8")));

    expect(sources.filter((s) => WAITS.test(s)).length).toBeGreaterThan(0);
    expect(sources.filter((s) => BINDS_DB.test(s)).length).toBeGreaterThan(0);
  });
});
