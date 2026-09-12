import { z } from "zod";

/**
 * Yuki job schemas
 */

export const yukiDecideDeliverySchema = z.object({
  /** The team whose inbox is decided against its own Yuki connection. */
  teamId: z.string().uuid(),
});

export type YukiDecideDeliveryPayload = z.infer<
  typeof yukiDecideDeliverySchema
>;

/**
 * How far back a pull reaches, by invoice date.
 *
 * The archive goes back five years; Midday's transactions go back one
 * (2025-08-08 at the time of writing). 404 of the 696 missing invoices predate
 * any transaction Midday will ever hold, so pulling them would put documents in
 * the inbox that can never match anything — noise in every count this epic is
 * trying to make honest.
 *
 * 2025-01-01 rather than the transaction window's own start, because an invoice
 * is often paid months after its date, and rather than "the last 13 months",
 * because whole fiscal years are how the books are closed and how an accountant
 * reads them. It is a parameter rather than a constant because the useful
 * cutoff moves: an Enable Banking backfill or more card history (FF-1517) both
 * widen Midday's window, and widening this is then a re-run rather than a code
 * change — the reference id makes re-running fetch only what is new.
 *
 * It lives here, with the payload, rather than beside the planner, because
 * Settings → Admin offers it as a field and the dashboard bundles this module.
 * The planner imports it from here; there is one value.
 */
export const DEFAULT_YUKI_PULL_CUTOFF = "2025-01-01";

/**
 * How many documents one run pulls.
 *
 * The first run has a backlog of roughly 290 documents, each a SOAP call, a
 * decode and a file into storage, and the task has ten minutes. Draining it
 * over a few days costs nothing — the pull is keyed on the Yuki document id, so
 * every run picks up where the last one stopped — and a bounded run is also
 * what keeps a first live run from being the largest thing this integration has
 * ever done.
 *
 * It stays 50 after the backlog is gone, where it is far above the two invoices
 * a week Yuki actually receives: the limit exists to bound a run, not to pace
 * a steady state that never reaches it.
 */
export const DEFAULT_YUKI_PULL_LIMIT = 50;

/**
 * The largest limit a run may be given.
 *
 * A person draining a backlog by hand wants more than 50; nobody wants more
 * than the task can finish inside its ten minutes, and 500 documents is already
 * well past that. The bound is here so that the payload, the Admin field and
 * the planner cannot disagree about it.
 */
export const MAX_YUKI_PULL_LIMIT = 500;

const cutoff = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "cutoff must be YYYY-MM-DD")
  .default(DEFAULT_YUKI_PULL_CUTOFF);

const limit = z
  .number()
  .int()
  .positive()
  .max(MAX_YUKI_PULL_LIMIT)
  .default(DEFAULT_YUKI_PULL_LIMIT);

/**
 * FF-1450 — pulling the purchase invoices Yuki holds and Midday does not, for
 * one team.
 *
 * Both knobs are on the payload rather than constants in the code because both
 * are things a person changes about a single run: how far back to reach, and
 * how much to do at once. Both default, so a caller that has no opinion sends
 * only a team id.
 */
export const yukiPullPurchaseInvoicesSchema = z.object({
  teamId: z.string().uuid(),
  /**
   * The oldest invoice date to pull, `YYYY-MM-DD`. Widening it later re-runs
   * cheaply: a document already pulled is keyed by its Yuki document id and is
   * never fetched twice.
   */
  cutoff,
  /** How many documents this run may pull. */
  limit,
});

export type YukiPullPurchaseInvoicesPayload = z.infer<
  typeof yukiPullPurchaseInvoicesSchema
>;

/**
 * FF-1541 — the same pull across every team that has connected Yuki.
 *
 * No team id: this is the one a schedule fires and the one Settings → Admin
 * starts, and neither of them is standing in a team. It fans out and runs the
 * per-team task above.
 */
export const yukiPullInvoicesSchema = z.object({
  cutoff,
  limit,
});

export type YukiPullInvoicesPayload = z.infer<typeof yukiPullInvoicesSchema>;
