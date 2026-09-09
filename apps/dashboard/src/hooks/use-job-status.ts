"use client";

import { readRunProgress, toJobStatus } from "@midday/jobs/run-status";
import { useRealtimeRun } from "@trigger.dev/react-hooks";

export type { JobStatus } from "@midday/jobs/run-status";

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

  const { progress, step } = readRunProgress(run?.metadata);

  return {
    status: toJobStatus(run?.status),
    progress,
    progressStep: step,
    result: run?.output,
    error: run?.error?.message,
    isLoading: subscribed && !run && !error,
    queryError: error,
  };
}
