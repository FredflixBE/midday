import { describe, expect, test } from "bun:test";
import {
  getMaintenanceAction,
  MAINTENANCE_ACTION_IDS,
  MAINTENANCE_ACTIONS,
} from "./maintenance";

describe("maintenance registry", () => {
  test("lists every declared id, in order", () => {
    expect(MAINTENANCE_ACTIONS.map((action) => action.id)).toEqual([
      ...MAINTENANCE_ACTION_IDS,
    ]);
  });

  test("each action names a distinct task", () => {
    const tasks = MAINTENANCE_ACTIONS.map((action) => action.task);

    expect(new Set(tasks).size).toBe(tasks.length);
  });

  test("resolves an action by id", () => {
    expect(getMaintenanceAction("sync-banks").task).toBe("sync-institutions");
    expect(getMaintenanceAction("check-bank-schedules").task).toBe(
      "ensure-bank-schedulers",
    );
  });

  test("rejects an id that is not in the registry", () => {
    expect(() =>
      // Only reachable if a caller skips the schema that validates the id.
      getMaintenanceAction("nope" as never),
    ).toThrow("Unknown maintenance action");
  });
});

describe("summarizing a run", () => {
  test("reports what the bank sync changed", () => {
    expect(
      getMaintenanceAction("sync-banks").summarize({
        upserted: 1203,
        removed: 4,
      }),
    ).toBe("Updated 1203 banks, and marked 4 as removed.");
  });

  test("says 'bank' rather than 'banks' for one", () => {
    expect(
      getMaintenanceAction("sync-banks").summarize({
        upserted: 1,
        removed: 0,
      }),
    ).toBe("Updated 1 bank, and marked 0 as removed.");
  });

  test("reports what the schedule check created", () => {
    expect(
      getMaintenanceAction("check-bank-schedules").summarize({
        eligible: 3,
        registered: 2,
        created: 1,
        failed: 0,
      }),
    ).toBe("Checked 3 teams, and created 1 schedule.");
  });

  test("mentions failures, and points at the logs", () => {
    expect(
      getMaintenanceAction("check-bank-schedules").summarize({
        eligible: 4,
        registered: 1,
        created: 1,
        failed: 2,
      }),
    ).toBe(
      "Checked 4 teams, and created 1 schedule. 2 teams failed — see the run's logs.",
    );
  });

  test("survives a run that returned nothing", () => {
    // A task whose flag is off, or an older deployment, returns undefined.
    for (const action of MAINTENANCE_ACTIONS) {
      expect(action.summarize(undefined)).toContain("0");
    }
  });
});
