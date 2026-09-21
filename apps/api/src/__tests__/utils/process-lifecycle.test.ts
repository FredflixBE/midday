import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  createProcessLifecycle,
  emptyState,
  type LifecycleState,
} from "@api/utils/process-lifecycle";

type Handle = ReturnType<typeof setInterval>;

const started = spyOn(globalThis, "setInterval");
const cleared = spyOn(globalThis, "clearInterval");

afterEach(() => {
  for (const call of started.mock.results) {
    globalThis.clearInterval(call.value as Handle);
  }
  started.mockClear();
  cleared.mockClear();
});

// The spies call through, but leaving them on would follow this file into
// whatever else shares the process when the whole suite runs at once.
afterAll(() => {
  started.mockRestore();
  cleared.mockRestore();
});

/**
 * One process, and the state that outlives an evaluation of the module.
 * `evaluate()` is one `bun --hot` pass — it builds a lifecycle from scratch,
 * as a reload does, over the state already there.
 */
const runningProcess = () => {
  const state: LifecycleState = emptyState();
  return { evaluate: () => createProcessLifecycle({ state }) };
};

const periods = () => started.mock.calls.map(([, ms]) => ms);

describe("startInterval", () => {
  test("clears the interval the evaluation before it started", () => {
    const { evaluate } = runningProcess();

    const first = evaluate().startInterval("pool-stats", () => {}, 60_000);
    const second = evaluate().startInterval("pool-stats", () => {}, 60_000);

    expect(periods()).toEqual([60_000, 60_000]);
    expect(cleared.mock.calls).toEqual([[first as Handle]]);
    expect(second).not.toBe(first);
  });

  test("leaves an interval under another name alone", () => {
    const { evaluate } = runningProcess();
    const lifecycle = evaluate();

    lifecycle.startInterval("pool-stats", () => {}, 60_000);
    lifecycle.startInterval("something-else", () => {}, 1_000);

    expect(cleared.mock.calls).toEqual([]);
  });

  test("a period of zero or less clears without starting one", () => {
    const { evaluate } = runningProcess();

    const first = evaluate().startInterval("pool-stats", () => {}, 60_000);
    const second = evaluate().startInterval("pool-stats", () => {}, 0);

    expect(second).toBeNull();
    expect(periods()).toEqual([60_000]);
    expect(cleared.mock.calls).toEqual([[first as Handle]]);
  });
});

describe("stopInterval", () => {
  test("clears a running interval once", () => {
    const { evaluate } = runningProcess();
    const lifecycle = evaluate();

    const handle = lifecycle.startInterval("pool-stats", () => {}, 60_000);
    lifecycle.stopInterval("pool-stats");
    lifecycle.stopInterval("pool-stats");

    expect(cleared.mock.calls).toEqual([[handle as Handle]]);
  });

  test("an interval that was never started is not an error", () => {
    const { evaluate } = runningProcess();

    evaluate().stopInterval("never-started");

    expect(cleared.mock.calls).toEqual([]);
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

describe("a second process", () => {
  test("carries none of the first one's claims", () => {
    const one = runningProcess();
    const two = runningProcess();

    one.evaluate().claim("shutdown");

    expect(two.evaluate().claim("shutdown")).toBe(true);
  });
});
