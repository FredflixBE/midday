/**
 * How a Trigger.dev run looks to the rest of the application.
 *
 * The API and the dashboard both need to turn a run into something the UI can
 * react to, and they need to agree. Keeping the vocabulary here means a new
 * status in the SDK is one edit, not two that can silently drift apart.
 */

/**
 * The status vocabulary the dashboard and the MCP tools speak, kept from the
 * BullMQ client so no caller had to change when the jobs moved.
 */
export type JobStatus =
  | "waiting"
  | "active"
  | "completed"
  | "failed"
  | "delayed"
  | "unknown";

/**
 * Trigger distinguishes more failure modes than the UI reacts to. Anything
 * terminal-but-not-successful is one thing to a user looking at a spinner.
 */
export function toJobStatus(status: string | undefined): JobStatus | undefined {
  if (!status) return undefined;

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
 * Progress a job reported into its run metadata, written by the shared
 * processor base in `@jobs/processors/base`.
 */
export interface RunProgress {
  progress?: number;
  step?: string;
}

export function readRunProgress(metadata: unknown): RunProgress {
  const fields = (metadata ?? {}) as { progress?: unknown; step?: unknown };

  return {
    progress: typeof fields.progress === "number" ? fields.progress : undefined,
    step: typeof fields.step === "string" ? fields.step : undefined,
  };
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
