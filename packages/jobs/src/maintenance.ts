/**
 * The maintenance jobs Settings → Admin can start by hand.
 *
 * Three schedules were removed to get back inside the Trigger.dev free plan's
 * ten (FF-1521). A schedule counts against that limit even when its run exits
 * immediately on a flag, so the only way to free a slot is to drop the cron —
 * which leaves the job with no way to be started. This list is that way.
 *
 * It lives in `@midday/jobs` rather than in the API or the dashboard because
 * both ends need it and they have to agree: the API validates the requested
 * action against it, and the dashboard renders one card per entry. Adding a
 * fourth maintenance job is therefore one entry here and nothing else.
 *
 * Keep this module free of server-only imports — the dashboard bundles it.
 */

export const MAINTENANCE_ACTION_IDS = [
  "sync-banks",
  "check-bank-schedules",
  "run-recurring-invoices",
] as const;

export type MaintenanceActionId = (typeof MAINTENANCE_ACTION_IDS)[number];

export interface MaintenanceAction {
  id: MaintenanceActionId;
  /** The Trigger.dev task id this starts. */
  task: string;
  title: string;
  description: string;
  /** The button's label. */
  label: string;
  /**
   * One sentence describing what a finished run did, for the person who
   * pressed the button. Takes the run's output, which arrives over the
   * realtime subscription as `unknown`.
   */
  summarize: (output: unknown) => string;
}

function count(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function fields(output: unknown): Record<string, unknown> {
  return output && typeof output === "object"
    ? (output as Record<string, unknown>)
    : {};
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export const MAINTENANCE_ACTIONS: readonly MaintenanceAction[] = [
  {
    id: "sync-banks",
    task: "sync-institutions",
    title: "Sync banks",
    description:
      "Fetch the list of banks from every connected provider, add the new ones and mark the ones that disappeared as removed. The list barely changes, so this is worth running before connecting a bank you cannot find.",
    label: "Sync banks",
    summarize: (output) => {
      const { upserted, removed } = fields(output);

      return `Updated ${plural(count(upserted), "bank", "banks")}, and marked ${count(
        removed,
      )} as removed.`;
    },
  },
  {
    id: "check-bank-schedules",
    task: "ensure-bank-schedulers",
    title: "Check bank schedules",
    description:
      "Make sure every team with a bank connection has a sync schedule, and create the ones that are missing. Connecting a bank already creates its schedule, so this is a safety net rather than a routine.",
    label: "Check schedules",
    summarize: (output) => {
      const { eligible, created, failed } = fields(output);
      const failures = count(failed);

      const summary = `Checked ${plural(
        count(eligible),
        "team",
        "teams",
      )}, and created ${plural(count(created), "schedule", "schedules")}.`;

      return failures > 0
        ? `${summary} ${plural(failures, "team", "teams")} failed — see the run's logs.`
        : summary;
    },
  },
  {
    id: "run-recurring-invoices",
    task: "invoice-recurring-daily",
    title: "Run recurring invoices",
    description:
      "Send the warnings for invoices coming in the next two days, then generate the ones that are due. This is the daily job, run now — it is also the only way to see the recurring-invoice feature work without waiting until 05:00 UTC.",
    label: "Run now",
    summarize: (output) => {
      const { warned, generated } = fields(output);

      if (warned === null || generated === null) {
        return "Part of the run failed — see the run's logs.";
      }

      return `Warned about ${plural(
        count(fields(warned).processed),
        "series",
        "series",
      )}, and generated ${plural(
        count(fields(generated).processed),
        "invoice",
        "invoices",
      )}.`;
    },
  },
];

const BY_ID = new Map<MaintenanceActionId, MaintenanceAction>(
  MAINTENANCE_ACTIONS.map((action) => [action.id, action]),
);

export function getMaintenanceAction(
  id: MaintenanceActionId,
): MaintenanceAction {
  const action = BY_ID.get(id);

  if (!action) {
    throw new Error(`Unknown maintenance action: ${id}`);
  }

  return action;
}
