"use client";

import { useRealtimeRun } from "@trigger.dev/react-hooks";

type UseJobStatusProps = {
  /** The Trigger.dev run id returned by the mutation that started the job. */
  runId?: string;
  /**
   * The run-scoped public token returned alongside it. Without this the
   * subscription cannot be opened, which is what keeps one team's run id from
   * being useful to anyone else.
   */
  accessToken?: string;
  enabled?: boolean;
};

/**
 * The status vocabulary this UI reacts to, kept from the BullMQ poller so the
 * components did not have to change when the jobs moved to Trigger.dev.
 */
export type JobStatus =
  | "waiting"
  | "active"
  | "completed"
  | "failed"
  | "delayed"
  | "unknown";

function toJobStatus(status: string | undefined): JobStatus | undefined {
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
 * Follow a job's progress over a live subscription.
 *
 * This used to poll `jobs.getStatus` once a second for as long as a job ran.
 * The shape it returns is unchanged; only where the numbers come from is —
 * progress and step are written into run metadata by the shared processor
 * base, and arrive here as the job reports them rather than on a timer.
 */
export function useJobStatus({
  runId,
  accessToken,
  enabled = true,
}: UseJobStatusProps = {}) {
  const subscribed = enabled && !!runId && !!accessToken;

  const { run, error } = useRealtimeRun(runId, {
    enabled: subscribed,
    accessToken,
  });

  const metadata = (run?.metadata ?? {}) as {
    progress?: unknown;
    step?: unknown;
  };

  return {
    status: toJobStatus(run?.status),
    progress:
      typeof metadata.progress === "number" ? metadata.progress : undefined,
    progressStep: typeof metadata.step === "string" ? metadata.step : undefined,
    result: run?.output,
    error: run?.error?.message,
    isLoading: subscribed && !run && !error,
    queryError: error,
  };
}
