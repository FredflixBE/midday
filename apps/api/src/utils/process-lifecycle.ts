/**
 * Registrations that belong to the process, not to this module's evaluation.
 *
 * `bun run --hot` re-runs the whole module graph inside the running process on
 * every save. Module scope is new each time; `process` and `globalThis` are
 * not. So `process.on("SIGTERM", ...)` in module scope stacks one more listener
 * per save — a single Ctrl-C was handled once per evaluation — and a
 * `setInterval` leaves the previous timer running beside the new one.
 *
 * Signal listeners are deliberately *not* handled here. Every arrangement that
 * had this module register them — attaching once and swapping the handler
 * behind it, or replacing the listener each evaluation, in either order — left
 * SIGTERM undeliverable from the first reload on, so the server died on Ctrl-C
 * without closing a connection, which is worse than the duplicate log it set
 * out to fix. The listeners stay in the entry module exactly as they were, and
 * `claim` makes the work behind them run once however many of them there are.
 *
 * Outside `--hot` the module is evaluated once and this is a thin pass-through.
 */

type IntervalHandle = ReturnType<typeof setInterval>;

/** The whole of what outlives an evaluation. Data, never behaviour. */
export type LifecycleState = {
  intervals: Map<string, IntervalHandle>;
  done: Set<string>;
};

export const emptyState = (): LifecycleState => ({
  intervals: new Map(),
  done: new Set(),
});

type Timers = {
  setInterval: (callback: () => void, ms: number) => IntervalHandle;
  clearInterval: (handle: IntervalHandle) => void;
};

type Options = {
  state?: LifecycleState;
  timers?: Timers;
};

export const createProcessLifecycle = ({
  state = emptyState(),
  timers = {
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearInterval: (handle) => clearInterval(handle),
  },
}: Options = {}) => {
  const stopInterval = (name: string) => {
    const running = state.intervals.get(name);
    if (running === undefined) return;

    state.intervals.delete(name);
    timers.clearInterval(running);
  };

  const claim = (name: string) => {
    if (state.done.has(name)) return false;

    state.done.add(name);
    return true;
  };

  return {
    /**
     * Start the interval known by `name`, replacing any the process is already
     * running under that name. A period of zero or less only clears.
     */
    startInterval(name: string, callback: () => void, ms: number) {
      stopInterval(name);
      if (ms <= 0) return null;

      const handle = timers.setInterval(callback, ms);
      state.intervals.set(name, handle);
      return handle;
    },

    stopInterval,

    /**
     * True for the first caller in this process and false for every one after.
     *
     * What a hot reload cannot be stopped from stacking is process listeners:
     * registering them from here, so that an evaluation could replace the last
     * one's, left the signal undeliverable and the server dying on Ctrl-C
     * without closing a connection. So the listeners stay where they are and
     * the work behind them is claimed instead — one signal, one shutdown,
     * whatever number of listeners passed it on.
     */
    claim,

    /** Run `task` the first time this process asks for it, and never again. */
    once(name: string, task: () => void) {
      if (claim(name)) task();
    },
  };
};

export type ProcessLifecycle = ReturnType<typeof createProcessLifecycle>;

const STATE = Symbol.for("@midday/api/process-lifecycle");

const globals = globalThis as unknown as Record<symbol, LifecycleState>;

// The state a hot reload has to find again, so it has to outlive this module.
globals[STATE] ??= emptyState();

export const processLifecycle = createProcessLifecycle({
  state: globals[STATE],
});
