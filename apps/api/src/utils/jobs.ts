import { createLoggerWithContext } from "@midday/logger";
import { runs } from "@trigger.dev/sdk";

const logger = createLoggerWithContext("jobs");

/**
 * The status vocabulary the dashboard and the MCP tools speak.
 *
 * Kept from the BullMQ client so callers did not have to change when the jobs
 * moved to Trigger.dev.
 */
export type JobStatus =
  | "waiting"
  | "active"
  | "completed"
  | "failed"
  | "delayed"
  | "unknown";

export interface JobStatusResponse {
  status: JobStatus;
  progress?: number;
  progressStep?: string;
  result?: unknown;
  error?: string;
}

/** Trigger has finer-grained statuses than the four the UI reacts to. */
function toJobStatus(status: string): JobStatus {
  switch (status) {
    case "QUEUED":
    case "PENDING_VERSION":
    case "DEQUEUED":
      return "waiting";
    case "EXECUTING":
    case "WAITING":
      return "active";
    case "COMPLETED":
      return "completed";
    case "DELAYED":
      return "delayed";
    case "FAILED":
    case "CRASHED":
    case "SYSTEM_FAILURE":
    case "TIMED_OUT":
    case "EXPIRED":
    case "CANCELED":
      return "failed";
    default:
      return "unknown";
  }
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

  // Progress is reported into run metadata by the shared processor base.
  const metadata = (run.metadata ?? {}) as {
    progress?: unknown;
    step?: unknown;
  };

  return {
    status: toJobStatus(run.status),
    progress:
      typeof metadata.progress === "number" ? metadata.progress : undefined,
    progressStep: typeof metadata.step === "string" ? metadata.step : undefined,
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

/**
 * What a mutation hands back when it starts a job the caller wants to follow.
 *
 * The SDK's run handle is a branded type carrying phantom payload and output
 * parameters; narrowing to this plain shape keeps that brand out of the tRPC
 * boundary, where it would only produce types the client cannot construct.
 */
export interface TriggeredRun {
  id: string;
  /** Scoped to this run, and the only way the dashboard can subscribe to it. */
  publicAccessToken: string;
}

export function toTriggeredRun(handle: {
  id: string;
  publicAccessToken: string;
}): TriggeredRun {
  return { id: handle.id, publicAccessToken: handle.publicAccessToken };
}
