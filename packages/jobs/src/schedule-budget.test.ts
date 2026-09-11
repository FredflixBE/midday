import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { MAINTENANCE_ACTIONS } from "./maintenance";

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

/**
 * Task ids declared by one of the three builders this package uses.
 *
 * The `id` is read from the first 200 characters of the definition rather than
 * from the very next line, so that reformatting a call does not quietly turn
 * this guard off by making it match nothing.
 */
async function declaredTaskIds(builders: string[]): Promise<string[]> {
  const pattern = new RegExp(
    `(?:${builders.join("|").replace(/\./g, "\\.")})\\(\\s*\\{[\\s\\S]{0,200}?id:\\s*"([^"]+)"`,
    "g",
  );
  const ids = new Set<string>();

  for (const file of await sourceFiles(join(import.meta.dir, "tasks"))) {
    const source = await readFile(file, "utf8");

    for (const match of source.matchAll(pattern)) {
      if (match[1]) ids.add(match[1]);
    }
  }

  return [...ids].sort();
}

/** Only the scheduled ones — these are what the plan's ten counts. */
const scheduleTaskIds = () => declaredTaskIds(["schedules.task"]);

/** Everything, however it was declared. */
const allTaskIds = () =>
  declaredTaskIds(["schedules.task", "schemaTask", "task"]);

describe("the schedule budget", () => {
  test("declares exactly the schedules the README lists", async () => {
    expect(await scheduleTaskIds()).toEqual(
      [...DECLARED_SCHEDULES, ...RUNTIME_SCHEDULES].sort(),
    );
  });

  test("finds the schedules at all", async () => {
    // A regex that matches nothing would make the list above pass by being
    // empty, which is the one way this guard can fail silently.
    expect((await scheduleTaskIds()).length).toBeGreaterThan(0);
  });

  test("leaves room for Yuki under the plan's ten", async () => {
    // The declared ones, plus one bank schedule and one inbox schedule for
    // the single team this fork serves.
    const inUse = (await scheduleTaskIds()).length;

    expect(inUse).toBeLessThan(10);
  });
});

describe("the maintenance actions", () => {
  test("each name a task that exists", async () => {
    // The registry refers to tasks by id, which nothing else checks: renaming
    // a task would otherwise leave a button that fails only when pressed.
    const declared = await allTaskIds();

    for (const action of MAINTENANCE_ACTIONS) {
      expect(declared).toContain(action.task);
    }
  });
});
