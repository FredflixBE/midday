import { describe, expect, test } from "bun:test";
import {
  defaultMaintenanceOptions,
  getMaintenanceAction,
  MAINTENANCE_ACTION_IDS,
  MAINTENANCE_ACTIONS,
  maintenanceOptions,
  maintenanceRunKey,
} from "./maintenance";
import {
  DEFAULT_YUKI_PULL_CUTOFF,
  DEFAULT_YUKI_PULL_LIMIT,
  MAX_YUKI_PULL_LIMIT,
} from "./schemas/yuki";

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
    expect(getMaintenanceAction("run-recurring-invoices").task).toBe(
      "invoice-recurring-daily",
    );
    expect(getMaintenanceAction("sync-yuki").task).toBe("yuki-daily");
    expect(getMaintenanceAction("pull-invoices").task).toBe(
      "yuki-pull-invoices",
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

  test("reports both halves of the recurring-invoice day", () => {
    expect(
      getMaintenanceAction("run-recurring-invoices").summarize({
        warned: { processed: 2 },
        generated: { processed: 1 },
      }),
    ).toBe("Warned about 2 series, and generated 1 invoice.");
  });

  test("does not claim a clean day when half of it failed", () => {
    // The daily job generates invoices even when the warnings failed, so a
    // run that succeeded is not the same as a run that did everything.
    expect(
      getMaintenanceAction("run-recurring-invoices").summarize({
        warned: null,
        generated: { processed: 1 },
      }),
    ).toBe("Part of the run failed — see the run's logs.");
  });

  test("reports what the books said, per status", () => {
    expect(
      getMaintenanceAction("sync-yuki").summarize({
        teams: 1,
        failed: 0,
        outcomes: [
          {
            teamId: "team-a",
            ok: true,
            output: { charges: 147, invoiceMissing: 68, needsAttention: 0 },
          },
        ],
      }),
    ).toBe(
      "Read 147 card charges across 1 team; 68 still have no invoice, and 0 need a look.",
    );
  });

  test("says plainly that nobody has connected the books", () => {
    // Zero teams and zero charges are different answers, and "read 0 charges"
    // reads like a sync that is broken.
    expect(getMaintenanceAction("sync-yuki").summarize({ teams: 0 })).toBe(
      "No team has the accounting integration connected, so there was nothing to read.",
    );
  });

  test("survives a run that returned nothing", () => {
    // A task whose flag is off, or an older deployment, returns undefined.
    // It must still say something, and it must not throw.
    for (const action of MAINTENANCE_ACTIONS) {
      const summary = action.summarize(undefined);

      expect(summary.length).toBeGreaterThan(0);
      expect(summary.endsWith(".")).toBe(true);
    }
  });
});

describe("summarizing the invoice pull", () => {
  const pull = (outcomes: unknown[], failed = 0) =>
    getMaintenanceAction("pull-invoices").summarize({
      teams: 1,
      failed,
      outcomes,
    });

  test("says what arrived and what is still to come", () => {
    expect(
      pull([
        {
          teamId: "team-a",
          ok: true,
          output: {
            pulled: 50,
            failed: 0,
            remaining: 264,
            autoMatched: 1,
            suggested: 9,
          },
        },
      ]),
    ).toBe(
      "Pulled 50 invoices, and matched 10 documents to a payment. 264 invoices are still to come — run it again.",
    );
  });

  test("says plainly when the backlog is gone", () => {
    // The one thing a person pressing this repeatedly is waiting to read.
    expect(
      pull([
        {
          teamId: "team-a",
          ok: true,
          output: {
            pulled: 1,
            failed: 0,
            remaining: 0,
            autoMatched: 0,
            suggested: 1,
          },
        },
      ]),
    ).toBe(
      "Pulled 1 invoice, and matched 1 document to a payment. Nothing is left to pull.",
    );
  });

  test("names both kinds of trouble, and points at the logs", () => {
    expect(
      pull(
        [
          {
            teamId: "team-a",
            ok: true,
            output: {
              pulled: 8,
              failed: 2,
              remaining: 0,
              autoMatched: 0,
              suggested: 0,
            },
          },
        ],
        1,
      ),
    ).toBe(
      "Pulled 8 invoices, and matched 0 documents to a payment. Nothing is left to pull. 2 documents could not be fetched, 1 team failed — see the run's logs.",
    );
  });

  test("says plainly that nobody has connected the books", () => {
    expect(getMaintenanceAction("pull-invoices").summarize({ teams: 0 })).toBe(
      "No team has the accounting integration connected, so there was nothing to pull.",
    );
  });
});

describe("the answers a job is started with", () => {
  const pullAction = getMaintenanceAction("pull-invoices");
  const syncBanks = getMaintenanceAction("sync-banks");

  test("fills in the task's own defaults when nothing was chosen", () => {
    expect(maintenanceOptions(pullAction, undefined)).toEqual({
      cutoff: DEFAULT_YUKI_PULL_CUTOFF,
      limit: DEFAULT_YUKI_PULL_LIMIT,
    });
  });

  test("starts the form on those same defaults", () => {
    // The form and an empty payload have to agree, or pressing the button
    // without touching anything would not be the run the schedule makes.
    expect(defaultMaintenanceOptions(pullAction)).toEqual(
      maintenanceOptions(pullAction, undefined) as Record<string, string>,
    );
  });

  test("keeps what was chosen", () => {
    expect(
      maintenanceOptions(pullAction, { cutoff: "2024-01-01", limit: 200 }),
    ).toEqual({ cutoff: "2024-01-01", limit: 200 });
  });

  test("refuses a date the task would refuse", () => {
    expect(() =>
      maintenanceOptions(pullAction, { cutoff: "01/01/2024" }),
    ).toThrow();
  });

  test("refuses a run larger than the task can finish", () => {
    expect(() =>
      maintenanceOptions(pullAction, { limit: MAX_YUKI_PULL_LIMIT + 1 }),
    ).toThrow();
  });

  test("hands a job that takes nothing an empty payload", () => {
    // Including when something was sent for it anyway.
    expect(maintenanceOptions(syncBanks, { cutoff: "2024-01-01" })).toEqual({});
    expect(defaultMaintenanceOptions(syncBanks)).toEqual({});
  });
});

describe("a job meant to be pressed again", () => {
  test("is the one that reports a backlog", () => {
    // The pull says what is left and asks to be run again; the window its key
    // lives for is shortened for that, in the router.
    expect(getMaintenanceAction("pull-invoices").repeatable).toBe(true);
  });

  test("is not the default", () => {
    expect(getMaintenanceAction("sync-banks").repeatable).toBeUndefined();
    expect(getMaintenanceAction("sync-yuki").repeatable).toBeUndefined();
  });
});

describe("the key one press runs under", () => {
  test("is the job's id alone when it takes no answers", () => {
    // Unchanged from before there were any, so a double-click still lands on
    // the run that is already going.
    expect(maintenanceRunKey(getMaintenanceAction("sync-banks"), {})).toBe(
      "maintenance:sync-banks",
    );
  });

  test("separates two runs of one job with different answers", () => {
    const action = getMaintenanceAction("pull-invoices");

    const first = maintenanceRunKey(action, {
      cutoff: "2025-01-01",
      limit: 50,
    });
    const second = maintenanceRunKey(action, {
      cutoff: "2020-01-01",
      limit: 50,
    });

    expect(first).not.toBe(second);
    // Changing the cutoff and pressing again inside the window must start a
    // new run, not hand back the previous one.
    expect(first).toBe("maintenance:pull-invoices:cutoff=2025-01-01,limit=50");
  });
});
