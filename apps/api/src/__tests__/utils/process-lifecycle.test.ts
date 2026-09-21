import { describe, expect, test } from "bun:test";
import { createProcessLifecycle } from "@api/utils/process-lifecycle";

type Listener = (...args: never[]) => void;

/** Stands in for `process`, so a test never registers on the real one. */
const fakeProcess = () => {
  const listeners = new Map<string, Listener[]>();

  return {
    count(event: string) {
      return listeners.get(event)?.length ?? 0;
    },
    emit(event: string, ...args: never[]) {
      for (const listener of listeners.get(event) ?? []) {
        listener(...args);
      }
    },
    on(event: string, listener: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
  };
};

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

const lifecycle = () => {
  const target = fakeProcess();
  const timers = fakeTimers();
  return { target, timers, ...createProcessLifecycle({ target, timers }) };
};

describe("registerHandlers", () => {
  test("attaches each process listener once, however often it is called", () => {
    const { target, registerHandlers } = lifecycle();
    const handlers = {
      shutdown: () => {},
      uncaughtException: () => {},
      unhandledRejection: () => {},
    };

    // Three evaluations of the same module, as `bun --hot` would do.
    registerHandlers(handlers);
    registerHandlers(handlers);
    registerHandlers(handlers);

    expect(target.count("SIGTERM")).toBe(1);
    expect(target.count("SIGINT")).toBe(1);
    expect(target.count("uncaughtException")).toBe(1);
    expect(target.count("unhandledRejection")).toBe(1);
  });

  test("one signal runs one shutdown, the newest one", () => {
    const { target, registerHandlers } = lifecycle();
    const stale: string[] = [];
    const current: string[] = [];

    registerHandlers({
      shutdown: (signal) => {
        stale.push(signal);
      },
      uncaughtException: () => {},
      unhandledRejection: () => {},
    });
    registerHandlers({
      shutdown: (signal) => {
        current.push(signal);
      },
      uncaughtException: () => {},
      unhandledRejection: () => {},
    });

    target.emit("SIGTERM");

    expect(stale).toEqual([]);
    expect(current).toEqual(["SIGTERM"]);
  });

  test("passes each signal its own name", () => {
    const { target, registerHandlers } = lifecycle();
    const signals: string[] = [];

    registerHandlers({
      shutdown: (signal) => {
        signals.push(signal);
      },
      uncaughtException: () => {},
      unhandledRejection: () => {},
    });

    target.emit("SIGINT");
    target.emit("SIGTERM");

    expect(signals).toEqual(["SIGINT", "SIGTERM"]);
  });

  test("hands an uncaught error and an unhandled rejection to the newest handlers", () => {
    const { target, registerHandlers } = lifecycle();
    const seen: unknown[] = [];

    registerHandlers({
      shutdown: () => {},
      uncaughtException: () => seen.push("stale"),
      unhandledRejection: () => seen.push("stale"),
    });
    registerHandlers({
      shutdown: () => {},
      uncaughtException: (error) => seen.push(error),
      unhandledRejection: (reason) => seen.push(reason),
    });

    const error = new Error("boom");
    target.emit("uncaughtException", ...([error] as never[]));
    target.emit("unhandledRejection", ...(["rejected"] as never[]));

    expect(seen).toEqual([error, "rejected"]);
  });
});

describe("startInterval", () => {
  test("clears the interval it replaces", () => {
    const { timers, startInterval } = lifecycle();

    const first = startInterval("pool-stats", () => {}, 60_000);
    const second = startInterval("pool-stats", () => {}, 60_000);

    expect(timers.started).toEqual([60_000, 60_000]);
    expect(timers.cleared).toEqual([first as Handle]);
    expect(second).not.toBe(first);
  });

  test("leaves an interval under another name alone", () => {
    const { timers, startInterval } = lifecycle();

    startInterval("pool-stats", () => {}, 60_000);
    startInterval("something-else", () => {}, 1_000);

    expect(timers.cleared).toEqual([]);
  });

  test("a period of zero or less clears without starting one", () => {
    const { timers, startInterval } = lifecycle();

    const first = startInterval("pool-stats", () => {}, 60_000);
    const second = startInterval("pool-stats", () => {}, 0);

    expect(second).toBeNull();
    expect(timers.started).toEqual([60_000]);
    expect(timers.cleared).toEqual([first as Handle]);
  });
});

describe("stopInterval", () => {
  test("clears a running interval once", () => {
    const { timers, startInterval, stopInterval } = lifecycle();

    const handle = startInterval("pool-stats", () => {}, 60_000);
    stopInterval("pool-stats");
    stopInterval("pool-stats");

    expect(timers.cleared).toEqual([handle as Handle]);
  });
});

describe("once", () => {
  test("runs the task on the first evaluation only", () => {
    const { once } = lifecycle();
    let runs = 0;

    once("warm-tool-index", () => {
      runs += 1;
    });
    once("warm-tool-index", () => {
      runs += 1;
    });

    expect(runs).toBe(1);
  });

  test("keeps tasks apart by name", () => {
    const { once } = lifecycle();
    const ran: string[] = [];

    once("first", () => ran.push("first"));
    once("second", () => ran.push("second"));

    expect(ran).toEqual(["first", "second"]);
  });
});

describe("a second process", () => {
  test("registers its own listeners and timers", () => {
    const one = lifecycle();
    const two = lifecycle();
    const handlers = {
      shutdown: () => {},
      uncaughtException: () => {},
      unhandledRejection: () => {},
    };

    one.registerHandlers(handlers);
    two.registerHandlers(handlers);
    one.once("warm-tool-index", () => {});
    let ranInTwo = false;
    two.once("warm-tool-index", () => {
      ranInTwo = true;
    });

    expect(two.target.count("SIGTERM")).toBe(1);
    expect(ranInTwo).toBe(true);
  });
});
