import type { JobContext, JobLogger } from "@jobs/processors/types";
import {
  classifyError,
  getMaxRetries,
  getRetryDelay,
  isNonRetryableError,
  NonRetryableError,
} from "@jobs/utils/error-classification";
import { extractErrorDetails } from "@jobs/utils/error-details";
import { logger as triggerLogger } from "@trigger.dev/sdk";
import type { ZodSchema } from "zod";

/**
 * Tag every line with the processor that wrote it, the way the worker's
 * pino child logger did, and send it to the Trigger run's log stream.
 */
function createProcessorLogger(context: string): JobLogger {
  const withContext = (properties?: Record<string, unknown>) => ({
    context,
    ...properties,
  });

  return {
    debug: (message, properties) =>
      triggerLogger.debug(message, withContext(properties)),
    info: (message, properties) =>
      triggerLogger.info(message, withContext(properties)),
    warn: (message, properties) =>
      triggerLogger.warn(message, withContext(properties)),
    error: (message, properties) =>
      triggerLogger.error(message, withContext(properties)),
  };
}

/**
 * Base processor class with error handling, retries, and logging
 */
export abstract class BaseProcessor<TData = unknown> {
  protected logger: JobLogger;

  constructor() {
    this.logger = createProcessorLogger(this.constructor.name);
  }

  /**
   * Optional Zod schema for payload validation
   * Override this in subclasses to enable automatic payload validation
   */
  protected getPayloadSchema(): ZodSchema<TData> | null {
    return null;
  }

  /**
   * Process the job
   * Override this method in subclasses
   */
  abstract process(job: JobContext<TData>): Promise<unknown>;

  /**
   * Validate job payload using Zod schema if provided
   */
  protected validatePayload(job: JobContext<TData>): TData {
    const schema = this.getPayloadSchema();
    if (!schema) {
      return job.data;
    }

    try {
      return schema.parse(job.data) as TData;
    } catch (error) {
      this.logger.error("Payload validation failed", {
        jobId: job.id,
        jobName: job.name,
        error: error instanceof Error ? error.message : "Unknown error",
        payload: JSON.stringify(job.data),
      });
      throw new NonRetryableError(
        `Invalid job payload: ${error instanceof Error ? error.message : "Unknown error"}`,
        error,
        "validation",
      );
    }
  }

  /**
   * Main handler, called once per run attempt
   */
  async handle(job: JobContext<TData>): Promise<unknown> {
    const startTime = Date.now();

    this.logger.info("Processing job", {
      jobId: job.id,
      jobName: job.name,
      attempt: job.attemptsMade + 1,
      maxAttempts: job.opts.attempts,
    });

    try {
      // Validate payload if schema is provided (throws on validation error)
      // Store the validated data and update job.data to include any Zod transformations/defaults
      const validatedData = this.validatePayload(job);
      job.data = validatedData;

      // Check idempotency
      const shouldProcess = await this.shouldProcess(job);
      if (!shouldProcess) {
        this.logger.info("Skipping job due to idempotency check", {
          jobId: job.id,
          jobName: job.name,
          idempotencyKey: this.getIdempotencyKey(job),
        });
        return { skipped: true, reason: "idempotency" };
      }

      if (job.opts.removeOnComplete !== false) {
        await this.updateProgress(
          job,
          this.ProgressMilestones.STARTED,
          "Job started",
        );
      }

      const result = await this.process(job);

      const duration = Date.now() - startTime;

      this.logger.info("Job completed", {
        jobId: job.id,
        jobName: job.name,
        duration: `${duration}ms`,
        hasResult: result !== undefined,
        resultType: typeof result,
      });

      // A run's output is stored as JSON, so a value that cannot be serialized
      // would fail after the work is already done. Fail loudly here instead.
      if (result !== undefined && result !== null) {
        try {
          const serialized = JSON.stringify(result);
          const sizeInMB = new Blob([serialized]).size / (1024 * 1024);
          if (sizeInMB > 100) {
            this.logger.warn("Large job result detected", {
              jobId: job.id,
              jobName: job.name,
              sizeMB: sizeInMB.toFixed(2),
            });
          }
        } catch (error) {
          this.logger.error("Result is not JSON-serializable", {
            jobId: job.id,
            jobName: job.name,
            error: error instanceof Error ? error.message : "Unknown error",
            resultType: typeof result,
            resultKeys:
              result && typeof result === "object"
                ? Object.keys(result)
                : undefined,
          });
          throw new Error(
            `Job result is not JSON-serializable: ${error instanceof Error ? error.message : "Unknown error"}`,
          );
        }
      }

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      const errorStack = error instanceof Error ? error.stack : undefined;
      const errorDetails = extractErrorDetails(error);
      const classified = classifyError(error);

      const isNonRetryable = isNonRetryableError(error);
      const shouldRetry = classified.retryable && !isNonRetryable;
      const remainingAttempts =
        (job.opts.attempts ?? 3) - (job.attemptsMade + 1);

      this.logger.error("Job failed", {
        jobId: job.id,
        jobName: job.name,
        attempt: job.attemptsMade + 1,
        maxAttempts: job.opts.attempts,
        remainingAttempts,
        duration: `${duration}ms`,
        error: errorMessage,
        errorCategory: classified.category,
        retryable: classified.retryable,
        isNonRetryable,
        shouldRetry,
        suggestedRetryDelay: getRetryDelay(error),
        suggestedMaxRetries: getMaxRetries(error),
        stack: errorStack,
        errorDetails,
      });

      // Wrap errors classified as non-retryable so the task wrapper can stop
      // the run instead of spending the remaining attempts on them.
      if (!shouldRetry && !isNonRetryable) {
        throw new NonRetryableError(errorMessage, error, classified.category);
      }

      throw error;
    }
  }

  /**
   * Report progress for the dashboard's realtime subscription.
   *
   * @param job - The job context
   * @param progress - Progress percentage (0-100)
   * @param message - Optional progress message
   */
  protected async updateProgress(
    job: JobContext<TData>,
    progress: number,
    message?: string,
    step?: string,
  ): Promise<void> {
    const clampedProgress = Math.max(0, Math.min(100, progress));

    try {
      await job.updateProgress({
        progress: clampedProgress,
        message,
        step,
      });
      this.logger.debug("Progress updated", {
        jobId: job.id,
        progress: `${clampedProgress}%`,
        message,
        step,
      });
    } catch (error) {
      // Don't fail the job if progress reporting fails
      this.logger.warn("Failed to update job progress", {
        jobId: job.id,
        progress: clampedProgress,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * Standard progress milestones for common job patterns
   */
  protected readonly ProgressMilestones = {
    STARTED: 0,
    VALIDATED: 5,
    FETCHED: 10,
    PROCESSING: 25,
    HALFWAY: 50,
    NEARLY_DONE: 75,
    FINALIZING: 90,
    COMPLETED: 100,
  } as const;

  /**
   * Check if a job should be processed (idempotency check)
   * Override this in subclasses to implement custom idempotency logic
   */
  protected async shouldProcess(_job: JobContext<TData>): Promise<boolean> {
    return true;
  }

  /**
   * Generate an idempotency key for a job
   * Override this in subclasses to generate custom idempotency keys
   */
  protected getIdempotencyKey(job: JobContext<TData>): string | null {
    return job.id ?? null;
  }
}
