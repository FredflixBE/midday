import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The Trigger.dev free plan allows ten schedules, and a schedule declared in
 * the code counts against that even when its run exits immediately on a flag.
 * Two more are created at runtime — one per team with a bank connection, one
 * per inbox account — and the Yuki integration wants one for itself.
 *
 * So the declared ones are a budget, not a detail, and the only way to spend a
 * slot by accident is to add a `schedules.task` without noticing. This test is
 * what makes that visible: it lists what is registered rather than counting,
 * so the diff says which job appeared.
 */
const DECLARED_SCHEDULES = [
  "invoice-recurring-scheduler",
  "invoice-scheduler",
  "invoice-upcoming-notification",
  "no-match-scheduler",
  "rates-scheduler",
];

/** Registered at runtime, one per entity, and not part of the budget above. */
const RUNTIME_SCHEDULES = ["bank-sync-scheduler", "inbox-sync-scheduler"];

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });

  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);

      if (entry.isDirectory()) return sourceFiles(path);
      return entry.name.endsWith(".ts") ? [path] : [];
    }),
  );

  return files.flat();
}

async function scheduleTaskIds(): Promise<string[]> {
  const tasksDir = join(import.meta.dir, "tasks");
  const ids: string[] = [];

  for (const file of await sourceFiles(tasksDir)) {
    const source = await readFile(file, "utf8");

    for (const match of source.matchAll(
      /schedules\.task\(\{\s*id:\s*"([^"]+)"/g,
    )) {
      const id = match[1];
      if (id) ids.push(id);
    }
  }

  return ids.sort();
}

describe("the schedule budget", () => {
  test("declares exactly the schedules the README lists", async () => {
    expect(await scheduleTaskIds()).toEqual(
      [...DECLARED_SCHEDULES, ...RUNTIME_SCHEDULES].sort(),
    );
  });

  test("leaves room for Yuki under the plan's ten", async () => {
    // The declared ones, plus one bank schedule and one inbox schedule for
    // the single team this fork serves.
    const inUse = (await scheduleTaskIds()).length;

    expect(inUse).toBeLessThan(10);
  });
});
