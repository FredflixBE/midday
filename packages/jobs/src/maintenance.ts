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

import { totalCardCharges, type YukiDayResult } from "./utils/yuki-day";

export const MAINTENANCE_ACTION_IDS = [
  "sync-banks",
  "check-bank-schedules",
  "run-recurring-invoices",
  "sync-yuki",
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
      "Warn about the invoices coming tomorrow, then generate the ones that are due. This is the daily job, run now — it is also how the recurring-invoice feature gets tested without waiting until 05:00 UTC.",
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
  {
    id: "sync-yuki",
    task: "yuki-daily",
    title: "Sync from the books",
    description:
      "Read the card charges the bank will not share out of the accountant's books, and say which of them still have no invoice. This is the daily job, run now.",
    label: "Run now",
    summarize: (output) => {
      const { teams, failed, outcomes } = fields(output);

      if (count(teams) === 0) {
        return "No team has the accounting integration connected, so there was nothing to read.";
      }

      // The counts live on the per-team runs; the day itself only knows how
      // many teams it visited.
      const { charges, invoiceMissing, needsAttention } = totalCardCharges({
        outcomes: Array.isArray(outcomes) ? outcomes : [],
      } as YukiDayResult);

      const summary = `Read ${plural(charges, "card charge", "card charges")} across ${plural(
        count(teams),
        "team",
        "teams",
      )}; ${invoiceMissing} still have no invoice, and ${needsAttention} need a look.`;

      return count(failed) > 0
        ? `${summary} ${plural(count(failed), "team", "teams")} failed — see the run's logs.`
        : summary;
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
