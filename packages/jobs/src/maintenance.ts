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
 * maintenance job is therefore one entry here and nothing else.
 *
 * Keep this module free of server-only imports — the dashboard bundles it.
 */

import type { ZodType } from "zod";
import {
  DEFAULT_YUKI_PULL_CUTOFF,
  DEFAULT_YUKI_PULL_LIMIT,
  MAX_YUKI_PULL_LIMIT,
  yukiPullInvoicesSchema,
} from "./schemas/yuki";
import {
  totalCardCharges,
  totalPulledInvoices,
  type YukiDayResult,
} from "./utils/yuki-day";

export const MAINTENANCE_ACTION_IDS = [
  "sync-banks",
  "check-bank-schedules",
  "run-recurring-invoices",
  "sync-yuki",
  "pull-invoices",
] as const;

export type MaintenanceActionId = (typeof MAINTENANCE_ACTION_IDS)[number];

/**
 * One value a job takes before it runs, as the Admin card asks for it.
 *
 * Most maintenance jobs take nothing — they are "do the daily thing now". A
 * job that does take something states it here, once: the card renders a field
 * per entry and the API validates what comes back against the task's own
 * payload schema, so neither end holds its own idea of what the job accepts.
 *
 * `defaultValue` is what the field starts on, and it is the same constant the
 * task defaults to, so the form and an empty payload agree.
 */
export type MaintenanceField =
  | {
      name: string;
      kind: "date";
      label: string;
      hint: string;
      defaultValue: string;
    }
  | {
      name: string;
      kind: "number";
      label: string;
      hint: string;
      defaultValue: number;
      min: number;
      max: number;
    };

export type MaintenanceOptions = Record<string, string | number>;

export interface MaintenanceAction {
  id: MaintenanceActionId;
  /** The Trigger.dev task id this starts. */
  task: string;
  title: string;
  description: string;
  /** The button's label. */
  label: string;
  /** What the card asks for before starting it. Absent means "just run it". */
  fields?: readonly MaintenanceField[];
  /**
   * Whether pressing this again straight away is the point of it.
   *
   * A maintenance run is normally pressed once, so its idempotency key lives
   * five minutes and a reload followed by a second press lands on the run
   * already going. A job that drains a backlog is the opposite: it reports what
   * is left and asks to be run again, and a five-minute window would hand back
   * the run that just finished — the button would appear to do nothing. This
   * shortens the window to long enough for a reload and no longer.
   */
  repeatable?: boolean;
  /**
   * The task's own payload schema, which is what the answers are validated
   * against. Sharing the task's schema rather than restating the rules here is
   * what stops the form accepting something the task then refuses.
   */
  optionsSchema?: ZodType;
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
      const { teams, failed } = fields(output);

      if (count(teams) === 0) {
        return "No team has the accounting integration connected, so there was nothing to read.";
      }

      // The counts live on the per-team runs; the day itself only knows how
      // many teams it visited.
      const { charges, invoiceMissing, needsAttention } = totalCardCharges(
        outcomesOf(output),
      );

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
  {
    id: "pull-invoices",
    task: "yuki-pull-invoices",
    title: "Pull invoices from the books",
    description:
      "Bring in the purchase invoices the accountant already has and Midday does not — the ones that arrived over Peppol, were keyed in, or were sent to the accountant directly. Each one is filed, matched to its payment where there is one, and closed. Safe to run again: a document already pulled is never fetched twice.",
    label: "Pull invoices",
    // Pressed again, on purpose, until the backlog is gone — see `repeatable`.
    repeatable: true,
    fields: [
      {
        name: "cutoff",
        kind: "date",
        label: "Invoices dated from",
        hint: "Anything older stays in the books. The default is the start of the last closed year; invoices before it predate every transaction Midday holds, so nothing could ever be matched to them.",
        defaultValue: DEFAULT_YUKI_PULL_CUTOFF,
      },
      {
        name: "limit",
        kind: "number",
        label: "At most",
        hint: `Documents per team, per run. Raise it to clear a backlog in one go; a run has ten minutes, so ${MAX_YUKI_PULL_LIMIT} is the ceiling.`,
        defaultValue: DEFAULT_YUKI_PULL_LIMIT,
        min: 1,
        max: MAX_YUKI_PULL_LIMIT,
      },
    ],
    optionsSchema: yukiPullInvoicesSchema,
    summarize: (output) => {
      const { teams, failed } = fields(output);

      if (count(teams) === 0) {
        return "No team has the accounting integration connected, so there was nothing to pull.";
      }

      const {
        pulled,
        remaining,
        matched,
        failed: documentsFailed,
      } = totalPulledInvoices(outcomesOf(output));

      // Two counts, not a ratio: what arrived this run, and what the matcher
      // found across everything it looked at — which also includes rows an
      // earlier run left unfinished, and excludes the copies that are never
      // matched. "50 pulled, 10 of which" would be a claim about neither.
      const summary = [
        `Pulled ${plural(pulled, "invoice", "invoices")}, and matched ${plural(
          matched,
          "document",
          "documents",
        )} to a payment.`,
        remaining > 0
          ? `${plural(remaining, "invoice is", "invoices are")} still to come — run it again.`
          : "Nothing is left to pull.",
      ].join(" ");

      const trouble = [
        documentsFailed > 0
          ? `${plural(documentsFailed, "document", "documents")} could not be fetched`
          : null,
        count(failed) > 0
          ? `${plural(count(failed), "team", "teams")} failed`
          : null,
      ].filter(Boolean);

      return trouble.length > 0
        ? `${summary} ${trouble.join(", ")} — see the run's logs.`
        : summary;
    },
  },
];

/** A day result's outcomes, for a summary reading a run's `unknown` output. */
function outcomesOf(output: unknown): YukiDayResult {
  const { outcomes } = fields(output);

  return {
    outcomes: Array.isArray(outcomes) ? outcomes : [],
  } as YukiDayResult;
}

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

/**
 * What a job should be started with, given whatever the card sent.
 *
 * Validation is the task's own payload schema, so a value the form accepts and
 * the task refuses cannot exist. An action with no schema takes no options, and
 * anything sent for it is dropped rather than forwarded — a task that ignores
 * its payload should not be handed one it never asked for.
 */
export function maintenanceOptions(
  action: MaintenanceAction,
  requested: MaintenanceOptions | undefined,
): Record<string, unknown> {
  if (!action.optionsSchema) return {};

  return action.optionsSchema.parse(requested ?? {}) as Record<string, unknown>;
}

/**
 * The defaults the card's fields start on.
 *
 * Separate from {@link maintenanceOptions} because it must not run the schema:
 * the form has to be renderable before anybody has typed anything valid.
 */
export function defaultMaintenanceOptions(
  action: MaintenanceAction,
): MaintenanceOptions {
  const options: MaintenanceOptions = {};

  for (const field of action.fields ?? []) {
    options[field.name] = field.defaultValue;
  }

  return options;
}

/**
 * The idempotency key for one press of one button.
 *
 * The options are part of it, because two runs of the same job with different
 * answers are two different runs — without them, changing the cutoff and
 * pressing again inside the window would hand back the previous run and look
 * like the new setting had no effect. A job that takes no options keys on its
 * id alone, exactly as before.
 */
export function maintenanceRunKey(
  action: MaintenanceAction,
  options: Record<string, unknown>,
): string {
  const fields = action.fields ?? [];
  if (fields.length === 0) return `maintenance:${action.id}`;

  const answers = fields
    .map((field) => `${field.name}=${String(options[field.name])}`)
    .join(",");

  return `maintenance:${action.id}:${answers}`;
}
