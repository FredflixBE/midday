import { describe, expect, test } from "bun:test";
import {
  createProcessLifecycle,
  emptyState,
  type LifecycleState,
} from "@api/utils/process-lifecycle";

type Handle = ReturnType<typeof setInterval>;

/** Records what was started and cleared, so no real timer has to fire. */
const fakeTimers = () => {
  const started: number[] = [];
  const cleared: Handle[] = [];
  let next = 1;

  return {
    started,
    cleared,
    setInterval: (_callback: () => void, ms: number) => {
      started.push(ms);
      return next++ as unknown as Handle;
    },
    clearInterval: (handle: Handle) => {
      cleared.push(handle);
    },
  };
};

/**
 * One process: its timers, and the state that outlives an evaluation.
 * `evaluate()` is one `bun --hot` pass over the module — it builds a lifecycle
 * from scratch, as a reload does, over the state already there.
 */
const runningProcess = () => {
  const timers = fakeTimers();
  const state: LifecycleState = emptyState();

  return {
    timers,
    evaluate: () => createProcessLifecycle({ state, timers }),
  };
};

describe("startInterval", () => {
  test("clears the interval the evaluation before it started", () => {
    const { timers, evaluate } = runningProcess();

    const first = evaluate().startInterval("pool-stats", () => {}, 60_000);
    const second = evaluate().startInterval("pool-stats", () => {}, 60_000);

    expect(timers.started).toEqual([60_000, 60_000]);
    expect(timers.cleared).toEqual([first as Handle]);
    expect(second).not.toBe(first);
  });

  test("leaves an interval under another name alone", () => {
    const { timers, evaluate } = runningProcess();
    const lifecycle = evaluate();

    lifecycle.startInterval("pool-stats", () => {}, 60_000);
    lifecycle.startInterval("something-else", () => {}, 1_000);

    expect(timers.cleared).toEqual([]);
  });

  test("a period of zero or less clears without starting one", () => {
    const { timers, evaluate } = runningProcess();

    const first = evaluate().startInterval("pool-stats", () => {}, 60_000);
    const second = evaluate().startInterval("pool-stats", () => {}, 0);

    expect(second).toBeNull();
    expect(timers.started).toEqual([60_000]);
    expect(timers.cleared).toEqual([first as Handle]);
  });
});

describe("stopInterval", () => {
  test("clears a running interval once", () => {
    const { timers, evaluate } = runningProcess();
    const lifecycle = evaluate();

    const handle = lifecycle.startInterval("pool-stats", () => {}, 60_000);
    lifecycle.stopInterval("pool-stats");
    lifecycle.stopInterval("pool-stats");

    expect(timers.cleared).toEqual([handle as Handle]);
  });

  test("an interval that was never started is not an error", () => {
    const { timers, evaluate } = runningProcess();

    evaluate().stopInterval("never-started");

    expect(timers.cleared).toEqual([]);
  });
});

describe("claim", () => {
  test("is true once, whichever evaluation asks", () => {
    const { evaluate } = runningProcess();

    // One signal reaching the listener every evaluation left behind.
    expect(evaluate().claim("shutdown")).toBe(true);
    expect(evaluate().claim("shutdown")).toBe(false);
    expect(evaluate().claim("shutdown")).toBe(false);
  });

  test("keeps claims apart by name", () => {
    const { evaluate } = runningProcess();
    const lifecycle = evaluate();

    expect(lifecycle.claim("shutdown")).toBe(true);
    expect(lifecycle.claim("warm-tool-index")).toBe(true);
  });
});

describe("once", () => {
  test("runs the task on the first evaluation only", () => {
    const { evaluate } = runningProcess();
    let runs = 0;
    const count = () => {
      runs += 1;
    };

    evaluate().once("warm-tool-index", count);
    evaluate().once("warm-tool-index", count);

    expect(runs).toBe(1);
  });

  test("keeps tasks apart by name", () => {
    const { evaluate } = runningProcess();
    const ran: string[] = [];
    const lifecycle = evaluate();

    lifecycle.once("first", () => ran.push("first"));
    lifecycle.once("second", () => ran.push("second"));

    expect(ran).toEqual(["first", "second"]);
  });
});

describe("a second process", () => {
  test("carries none of the first one's claims", () => {
    const one = runningProcess();
    const two = runningProcess();

    one.evaluate().claim("shutdown");

    expect(two.evaluate().claim("shutdown")).toBe(true);
  });
});
