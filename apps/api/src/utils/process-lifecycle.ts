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

type Options = {
  state?: LifecycleState;
};

export const createProcessLifecycle = ({
  state = emptyState(),
}: Options = {}) => {
  const stopInterval = (name: string) => {
    const running = state.intervals.get(name);
    if (running === undefined) return;

    state.intervals.delete(name);
    clearInterval(running);
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

      const handle = setInterval(callback, ms);
      state.intervals.set(name, handle);
      return handle;
    },

    stopInterval,

    /** True for the first caller in this process, false for every one after. */
    claim,
  };
};

export type ProcessLifecycle = ReturnType<typeof createProcessLifecycle>;

const STATE = Symbol.for("@midday/api/process-lifecycle");

const globals = globalThis as unknown as {
  [STATE]?: LifecycleState;
};

// The state a hot reload has to find again, so it has to outlive this module.
globals[STATE] ??= emptyState();

export const processLifecycle = createProcessLifecycle({
  state: globals[STATE],
});
