"use client";

import type { MaintenanceAction } from "@midday/jobs/maintenance";
import { Button } from "@midday/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@midday/ui/card";
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { useJobStatus } from "@/hooks/use-job-status";
import { useTRPC } from "@/trpc/client";

type Props = {
  action: MaintenanceAction;
};

/**
 * One maintenance job: a button that starts it, and what the run did
 * underneath.
 *
 * The card holds the run it started rather than lifting that state up. Two
 * jobs started from this page are unrelated, and each only has to be followed
 * for as long as its own card is on screen.
 */
export function MaintenanceActionCard({ action }: Props) {
  const trpc = useTRPC();
  const [run, setRun] = useState<{ id: string; accessToken: string }>();

  const mutation = useMutation(
    trpc.admin.runMaintenanceTask.mutationOptions({
      onSuccess: (data) => {
        setRun({ id: data.id, accessToken: data.publicAccessToken });
      },
    }),
  );

  const { status, result, error, queryError } = useJobStatus({
    runId: run?.id,
    accessToken: run?.accessToken,
  });

  const finished = status === "completed" || status === "failed";
  // These jobs take minutes, so the button stays disabled for the whole run
  // rather than only while the mutation is in flight.
  const running = mutation.isPending || (!!run && !finished && !queryError);

  const message = describe();

  function describe(): string | undefined {
    if (mutation.error) {
      return `Could not start the job: ${mutation.error.message}`;
    }

    // The run is going, but the subscription that reports on it is not. The
    // job is unaffected; only this page has lost sight of it.
    if (queryError) {
      return "Started, but this page lost track of the run. Check Trigger.dev for the result.";
    }

    if (!run || !finished) return undefined;

    if (status === "completed") return action.summarize(result);

    return error ? `The run failed: ${error}` : "The run failed.";
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{action.title}</CardTitle>
        <CardDescription>{action.description}</CardDescription>
      </CardHeader>

      {message && (
        <CardContent className="pb-0">
          <p className="text-sm text-[#606060]">{message}</p>
        </CardContent>
      )}

      <CardFooter>
        <Button
          onClick={() => mutation.mutate({ action: action.id })}
          disabled={running}
        >
          {running ? (
            <>
              <Loader2 className="size-4 animate-spin mr-2" />
              Running…
            </>
          ) : (
            action.label
          )}
        </Button>
      </CardFooter>
    </Card>
  );
}
