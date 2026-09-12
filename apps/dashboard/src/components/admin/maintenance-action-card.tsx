"use client";

import {
  defaultMaintenanceOptions,
  getMaintenanceAction,
  type MaintenanceActionId,
  type MaintenanceField,
  type MaintenanceOptions,
} from "@midday/jobs/maintenance";
import { Button } from "@midday/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@midday/ui/card";
import { Input } from "@midday/ui/input";
import { Label } from "@midday/ui/label";
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { useJobStatus } from "@/hooks/use-job-status";
import { useTRPC } from "@/trpc/client";

type Props = {
  id: MaintenanceActionId;
};

/**
 * One maintenance job: a button that starts it, and what the run did
 * underneath.
 *
 * Takes the id rather than the action, and looks the action up here, because
 * the list that renders these is a server component and an action carries a
 * `summarize` function — which does not survive that boundary (FF-1525).
 *
 * The card holds the run it started rather than lifting that state up. Two
 * jobs started from this page are unrelated, and each only has to be followed
 * for as long as its own card is on screen.
 */
export function MaintenanceActionCard({ id }: Props) {
  const action = getMaintenanceAction(id);
  const trpc = useTRPC();
  const [run, setRun] = useState<{ id: string; accessToken: string }>();
  // Starts on the same values the task defaults to, so pressing the button
  // without touching anything is the same run the schedule would have made.
  const [options, setOptions] = useState<MaintenanceOptions>(() =>
    defaultMaintenanceOptions(action),
  );

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

      {(action.fields || message) && (
        <CardContent className="pb-0 space-y-4">
          {action.fields?.map((field) => (
            <MaintenanceInput
              key={field.name}
              field={field}
              value={options[field.name] ?? field.defaultValue}
              disabled={running}
              onChange={(value) =>
                setOptions((current) => ({ ...current, [field.name]: value }))
              }
            />
          ))}

          {message && <p className="text-sm text-[#606060]">{message}</p>}
        </CardContent>
      )}

      <CardFooter>
        <Button
          onClick={() =>
            mutation.mutate({
              action: action.id,
              ...(action.fields ? { options } : {}),
            })
          }
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

/**
 * One answer a job wants before it runs.
 *
 * Deliberately plain: these are developer-only controls on a page only the
 * developer sees, and a date and a number are what the jobs actually ask for.
 * A number empties to its own default rather than to nothing, because an empty
 * numeric input would otherwise send `NaN` to a job the whole point of which is
 * that it is bounded.
 */
function MaintenanceInput({
  field,
  value,
  disabled,
  onChange,
}: {
  field: MaintenanceField;
  value: string | number;
  disabled: boolean;
  onChange: (value: string | number) => void;
}) {
  const inputId = `maintenance-${field.name}`;

  return (
    <div className="space-y-2">
      <Label htmlFor={inputId}>{field.label}</Label>

      {field.kind === "date" ? (
        <Input
          id={inputId}
          type="date"
          className="w-[200px]"
          value={String(value)}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Input
          id={inputId}
          type="number"
          className="w-[120px]"
          min={field.min}
          max={field.max}
          value={String(value)}
          disabled={disabled}
          onChange={(event) => {
            const next = Number.parseInt(event.target.value, 10);
            onChange(Number.isNaN(next) ? field.defaultValue : next);
          }}
        />
      )}

      <p className="text-xs text-[#606060]">{field.hint}</p>
    </div>
  );
}
