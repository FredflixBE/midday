import type { BaseProcessor } from "@jobs/processors/base";
import type { JobContext, TaskRunContext } from "@jobs/processors/types";
import { isNonRetryableError } from "@jobs/utils/error-classification";
import { AbortTaskRunError, logger, metadata } from "@trigger.dev/sdk";

/**
 * Build the job context a ported processor runs against.
 *
 * Progress lands in the run's metadata, which is what `useRealtimeRun` in the
 * dashboard streams — the same numbers the BullMQ status poller used to read,
 * arriving over a subscription instead of a poll.
 */
export function createJobContext<TData>(
  name: string,
  data: TData,
  ctx: TaskRunContext,
): JobContext<TData> {
  return {
    data,
    id: ctx.run.id,
    name,
    // BullMQ counted attempts already made; Trigger numbers the current one.
    attemptsMade: Math.max((ctx.attempt?.number ?? 1) - 1, 0),
    opts: { attempts: ctx.run.maxAttempts },
    updateProgress: async (value) => {
      if (typeof value === "number") {
        metadata.set("progress", value);
        return;
      }

      const { progress, step } = value as {
        progress?: unknown;
        step?: unknown;
      };

      if (typeof progress === "number") {
        metadata.set("progress", progress);
      }
      if (typeof step === "string") {
        metadata.set("step", step);
      }
    },
  };
}

/**
 * A processor, typed so the task built from it reports the result type the
 * subclass declares on `process` rather than the base class's `unknown`.
 *
 * (`handle` can also return a skip marker, but that path needs a processor to
 * override `shouldProcess`, and none does.)
 */
type Processor<TData, TResult> = BaseProcessor<TData> & {
  process(job: JobContext<TData>): Promise<TResult>;
};

/**
 * Run a processor without translating its errors.
 *
 * Use this when the task needs to inspect the thrown error itself — the
 * document tasks do, because an unsupported file type is a normal outcome
 * rather than a failure. Pair it with {@link toTaskError}.
 */
export function handleJob<TData, TResult>(
  processor: Processor<TData, TResult>,
  name: string,
  data: TData,
  ctx: TaskRunContext,
): Promise<TResult> {
  return processor.handle(
    createJobContext(name, data, ctx),
  ) as Promise<TResult>;
}

/**
 * Turn an error the processor classified as non-retryable into the one Trigger
 * understands, so the run stops now instead of spending its remaining attempts
 * on something that cannot succeed.
 */
export function toTaskError(error: unknown): unknown {
  if (isNonRetryableError(error)) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Aborting run: error is not retryable", { error: message });
    return new AbortTaskRunError(message);
  }

  return error;
}

/**
 * Run a processor as the body of a Trigger task. The common case.
 */
export async function runProcessor<TData, TResult>(
  processor: Processor<TData, TResult>,
  name: string,
  data: TData,
  ctx: TaskRunContext,
): Promise<TResult> {
  try {
    return await handleJob(processor, name, data, ctx);
  } catch (error) {
    throw toTaskError(error);
  }
}
