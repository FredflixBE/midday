"use client";

import { settleRun, toJobStatus } from "@midday/jobs/run-status";
import { useQuery } from "@tanstack/react-query";
import { useApiClient, useRealtimeRun } from "@trigger.dev/react-hooks";

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

/** How often to look a run up once the live connection has failed. */
const LOOKUP_INTERVAL_MS = 3_000;

function finished(status: string | undefined) {
  const job = toJobStatus(status);
  return job === "completed" || job === "failed";
}

/**
 * Follow a job's progress over a live subscription.
 *
 * Progress and step are written into run metadata by the shared processor
 * base and arrive here as the job reports them. When the live connection
 * reports an error before the run has finished, the run is looked up directly
 * with the same token until it does (FF-2282), so a dropped connection costs
 * a few seconds of delay rather than the result.
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

  const apiClient = useApiClient({ accessToken, enabled: subscribed });
  const lookupNeeded =
    subscribed && !!error && !finished(run?.status) && !!apiClient;

  const lookup = useQuery({
    queryKey: ["job-run-lookup", runId],
    queryFn: () => apiClient!.retrieveRun(runId!),
    enabled: lookupNeeded,
    refetchInterval: (query) =>
      finished(query.state.data?.status) ? false : LOOKUP_INTERVAL_MS,
    retry: 2,
  });

  const settled = settleRun({
    live: run,
    liveError: error,
    lookup: lookup.data,
    lookupError: lookup.error,
  });

  return {
    status: settled.status,
    progress: settled.progress.progress,
    progressStep: settled.progress.step,
    result: settled.result,
    error: settled.error,
    isLoading: subscribed && !run && !lookup.data && !settled.lostTrack,
    queryError: settled.lostTrack ? (lookup.error ?? error) : undefined,
  };
}
