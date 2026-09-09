/**
 * The shape the ported worker processors expect.
 *
 * The processors were written against BullMQ's `Job`, of which they use only a
 * handful of members. Restating those here is what lets the same classes run on
 * Trigger.dev without touching their bodies — and it is a much smaller surface
 * than `Job`, so it is obvious what a processor is allowed to reach for.
 */
export interface JobContext<TData = unknown> {
  /** The validated payload. */
  data: TData;
  /** The Trigger run id. Processors only ever log this. */
  id?: string;
  /** The task id, e.g. "process-attachment". */
  name: string;
  /** Attempts completed before this one; 0 on the first run. */
  attemptsMade: number;
  opts: {
    attempts?: number;
    /** Never set here; kept so the base class's progress guard still reads. */
    removeOnComplete?: boolean;
  };
  updateProgress(value: number | Record<string, unknown>): Promise<void>;
}

/**
 * The logging surface the processors use.
 *
 * Structurally satisfied by both pino (what the worker had) and Trigger's
 * `logger` (what they get now), so no call site had to change.
 */
export interface JobLogger {
  debug(message: string, properties?: Record<string, unknown>): void;
  info(message: string, properties?: Record<string, unknown>): void;
  warn(message: string, properties?: Record<string, unknown>): void;
  error(message: string, properties?: Record<string, unknown>): void;
}

/**
 * The part of Trigger's run context a job context is built from.
 *
 * Declared structurally rather than imported so a future SDK bump that adds
 * fields cannot break the build here.
 */
export interface TaskRunContext {
  run: { id: string; maxAttempts?: number };
  attempt?: { number?: number };
}
