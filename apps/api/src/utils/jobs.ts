import {
  type JobStatus,
  readRunProgress,
  toJobStatus,
} from "@midday/jobs/run-status";
import { createLoggerWithContext } from "@midday/logger";
import { runs } from "@trigger.dev/sdk";

const logger = createLoggerWithContext("jobs");

export type { JobStatus, TriggeredRun } from "@midday/jobs/run-status";
export { toTriggeredRun } from "@midday/jobs/run-status";

export interface JobStatusResponse {
  status: JobStatus;
  progress?: number;
  progressStep?: string;
  result?: unknown;
  error?: string;
}

/**
 * Read the status of a run this API started.
 *
 * A run id is guessable enough that it cannot be the only credential, so this
 * checks the team the run was started for — the same check the BullMQ client
 * made against `job.data.teamId`, against the run payload instead.
 *
 * @throws if the run belongs to another team, or to no team at all
 */
export async function getRunStatus(
  runId: string,
  options?: { teamId?: string },
): Promise<JobStatusResponse> {
  const requestingTeamId = options?.teamId;

  let run: Awaited<ReturnType<typeof runs.retrieve>>;
  try {
    run = await runs.retrieve(runId);
  } catch (error) {
    logger.warn("Run not found", {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: "unknown" };
  }

  if (requestingTeamId) {
    const runTeamId = (run.payload as { teamId?: string } | undefined)?.teamId;

    if (!runTeamId) {
      // A run with no team is a system job (a scheduler, say). Team-scoped
      // callers have no business reading those.
      logger.warn("Attempted to access system run from team context", {
        runId,
        taskIdentifier: run.taskIdentifier,
        requestingTeamId,
      });
      throw new Error("Job not found or access denied");
    }

    if (runTeamId !== requestingTeamId) {
      logger.warn("Unauthorized run access attempt", {
        runId,
        taskIdentifier: run.taskIdentifier,
        requestingTeamId,
        runTeamId,
      });
      throw new Error("Job not found or access denied");
    }
  }

  const { progress, step } = readRunProgress(run.metadata);

  return {
    status: toJobStatus(run.status) ?? "unknown",
    progress,
    progressStep: step,
    result: run.output,
    error: run.error?.message,
  };
}

/**
 * Cancel a scheduled run, best effort.
 *
 * Callers use this when rescheduling or cancelling a scheduled invoice. A
 * failure here is survivable: the run verifies it is still the one the invoice
 * points at before it does anything, so a stray run stops on its own.
 */
export async function cancelScheduledRun(runId: string): Promise<void> {
  try {
    await runs.cancel(runId);
  } catch (error) {
    logger.error("Failed to cancel scheduled run", {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
