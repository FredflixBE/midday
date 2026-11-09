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

/** What the UI needs from a run, from either the live connection or a lookup. */
export interface RunView {
  status?: string;
  output?: unknown;
  error?: { message?: string } | null;
  metadata?: unknown;
}

export interface SettledRun {
  status: JobStatus | undefined;
  result: unknown;
  error: string | undefined;
  progress: RunProgress;
  /** Neither the live connection nor a direct lookup can see the run. */
  lostTrack: boolean;
}

function isFinished(status: JobStatus | undefined): boolean {
  return status === "completed" || status === "failed";
}

/**
 * One answer about a run from the two ways a page can follow it.
 *
 * The live connection is the normal path. When it reports an error, the page
 * looks the run up directly with the same run-scoped token (FF-2282): in
 * production a connection error once replaced a run that had already answered
 * with "lost track". A finished run wins from whichever source has it, and the
 * page has lost track only when the lookup fails as well.
 */
export function settleRun({
  live,
  liveError,
  lookup,
  lookupError,
}: {
  live?: RunView;
  liveError?: unknown;
  lookup?: RunView;
  lookupError?: unknown;
}): SettledRun {
  const liveStatus = toJobStatus(live?.status);
  const lookupStatus = toJobStatus(lookup?.status);

  const source =
    isFinished(liveStatus) || !liveError
      ? live
      : lookup && (isFinished(lookupStatus) || !live)
        ? lookup
        : (live ?? lookup);

  return {
    status: toJobStatus(source?.status),
    result: source?.output,
    error: source?.error?.message ?? undefined,
    progress: readRunProgress(source?.metadata),
    lostTrack:
      !!liveError &&
      !isFinished(liveStatus) &&
      !isFinished(lookupStatus) &&
      !!lookupError,
  };
}
