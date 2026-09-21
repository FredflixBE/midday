/**
 * Registrations that belong to the process, not to this module's evaluation.
 *
 * `bun run --hot` re-runs the whole module graph inside the running process on
 * every save. Module scope is new each time; `process` and `globalThis` are
 * not. So `process.on("SIGTERM", ...)` in module scope stacks one more listener
 * per save — a single Ctrl-C then logged a graceful shutdown once per
 * evaluation — and a `setInterval` left the previous timer ticking beside the
 * new one. Route both through here and they happen once per process, with the
 * newest evaluation's behaviour behind them.
 *
 * Outside `--hot` the module is evaluated once and this is a thin pass-through.
 */

export type ProcessHandlers = {
  shutdown: (signal: string) => void | Promise<void>;
  uncaughtException: (error: Error) => void;
  unhandledRejection: (reason: unknown) => void;
};

type IntervalHandle = ReturnType<typeof setInterval>;

type Timers = {
  setInterval: (callback: () => void, ms: number) => IntervalHandle;
  clearInterval: (handle: IntervalHandle) => void;
};

type ProcessTarget = {
  on: (event: string, listener: (...args: never[]) => void) => void;
};

type Options = {
  target?: ProcessTarget;
  timers?: Timers;
};

export const createProcessLifecycle = ({
  target = process as unknown as ProcessTarget,
  timers = {
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearInterval: (handle) => clearInterval(handle),
  },
}: Options = {}) => {
  const intervals = new Map<string, IntervalHandle>();
  const done = new Set<string>();
  let handlers: ProcessHandlers | undefined;
  let attached = false;

  const stopInterval = (name: string) => {
    const running = intervals.get(name);
    if (running === undefined) return;

    intervals.delete(name);
    timers.clearInterval(running);
  };

  return {
    /**
     * Point the process's signal and crash listeners at `next`, attaching them
     * on the first call and only swapping the handlers on every call after.
     */
    registerHandlers(next: ProcessHandlers) {
      handlers = next;
      if (attached) return;
      attached = true;

      target.on("SIGTERM", () => handlers?.shutdown("SIGTERM"));
      target.on("SIGINT", () => handlers?.shutdown("SIGINT"));
      target.on("uncaughtException", (error: Error) =>
        handlers?.uncaughtException(error),
      );
      target.on("unhandledRejection", (reason: unknown) =>
        handlers?.unhandledRejection(reason),
      );
    },

    /**
     * Start the interval known by `name`, replacing any the process is already
     * running under that name. A period of zero or less only clears.
     */
    startInterval(name: string, callback: () => void, ms: number) {
      stopInterval(name);
      if (ms <= 0) return null;

      const handle = timers.setInterval(callback, ms);
      intervals.set(name, handle);
      return handle;
    },

    stopInterval,

    /** Run `task` the first time this process asks for it, and never again. */
    once(name: string, task: () => void) {
      if (done.has(name)) return;
      done.add(name);
      task();
    },
  };
};

export type ProcessLifecycle = ReturnType<typeof createProcessLifecycle>;

const LIFECYCLE = Symbol.for("@midday/api/process-lifecycle");

const store = globalThis as unknown as Record<symbol, ProcessLifecycle>;

// The one a hot reload must find again, so it has to outlive this module.
store[LIFECYCLE] ??= createProcessLifecycle();

export const processLifecycle = store[LIFECYCLE];
