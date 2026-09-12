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
 * FF-1450 — pulling the purchase invoices Yuki holds and Midday does not.
 *
 * Both knobs are optional and both have defaults in `@jobs/utils/yuki-pull`,
 * so the schedule sends only a team id. They are on the payload rather than
 * constants in the code because both are things a person changes about a
 * single run: how far back to reach, and how much to do at once.
 */
export const yukiPullPurchaseInvoicesSchema = z.object({
  teamId: z.string().uuid(),
  /**
   * The oldest invoice date to pull, `YYYY-MM-DD`. Defaults to
   * `DEFAULT_YUKI_PULL_CUTOFF`. Widening it later re-runs cheaply: a document
   * already pulled is keyed by its Yuki document id and never fetched twice.
   */
  cutoff: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "cutoff must be YYYY-MM-DD")
    .optional(),
  /** How many documents this run may pull. Defaults to `DEFAULT_YUKI_PULL_LIMIT`. */
  limit: z.number().int().positive().max(500).optional(),
});

export type YukiPullPurchaseInvoicesPayload = z.infer<
  typeof yukiPullPurchaseInvoicesSchema
>;
