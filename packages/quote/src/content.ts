import { z } from "zod";

/**
 * What a quote version holds (FF-1609, docs/quotes.md §3.3): the proposal
 * text, the rate settings, and the priced scenarios with their lines. It is
 * stored as jsonb in `quote_versions.content` and every write is checked
 * against this schema, so the shape is enforced here rather than by tables.
 *
 * The schema checks that content is well-formed, not that a quote is ready to
 * send: a draft is saved at every step of editing, half-finished. Whether the
 * numbers add up (a payment schedule reaching 100%, say) is the pricing
 * calculation's to report.
 */

const id = z.string().min(1).max(100);

/** Hours are never negative; quarters and halves are normal. */
const hours = z.number().min(0).max(1_000_000);

/** An adjustment on a rate, in percent. −100 would make the work free. */
const percent = z.number().gt(-100).max(1000);

/** A Tiptap document, the same shape as an invoice's `topBlock`. */
export const editorDocSchema = z.object({
  type: z.literal("doc"),
  content: z.array(z.record(z.string(), z.unknown())),
});

/** A block of the proposal's text: a heading and what was written under it. */
export const textBlockSchema = z.object({
  id,
  type: z.literal("text"),
  heading: z.string().max(500).nullable(),
  body: editorDocSchema,
});

export const blockSchema = z.discriminatedUnion("type", [
  textBlockSchema,
  /** Where the scenarios appear among the text. */
  z.object({ id, type: z.literal("pricing") }),
  /**
   * Where the list of sections appears (FF-1668). Like the pricing, it holds
   * nothing of its own: it marks a place, and what is drawn there is worked
   * out from the blocks around it.
   */
  z.object({ id, type: z.literal("contents") }),
]);

export const lineSchema = z.discriminatedUnion("type", [
  z.object({ id, type: z.literal("section"), title: z.string().max(500) }),
  z.object({ id, type: z.literal("note"), text: z.string().max(5000) }),
  z
    .object({
      id,
      type: z.literal("item"),
      title: z.string().max(500),
      description: z.string().max(5000).nullable(),
      productId: z.string(),
      /** A fixed scenario's hours; a range scenario's minimum. */
      hours,
      /** A range scenario's maximum. */
      hoursMax: hours.nullable(),
      /** Priced, shown, and left out of every total. */
      optional: z.boolean(),
      /** On a recurring quote: charged once, not every period. */
      once: z.boolean(),
    })
    .refine((line) => line.hoursMax === null || line.hoursMax >= line.hours, {
      message: "The maximum hours cannot be below the minimum",
      path: ["hoursMax"],
    }),
]);

export const recurrenceSchema = z.object({
  period: z.enum(["month", "quarter", "year"]),
  /** Null is an indefinite term. */
  termMonths: z.number().int().min(1).max(1200).nullable(),
  billing: z.enum(["in_advance", "in_arrears"]),
  autoRenew: z.boolean(),
  noticeMonths: z.number().int().min(0).max(120).nullable(),
});

export const scenarioSchema = z.object({
  id,
  name: z.string().max(200),
  recommended: z.boolean(),
  pricing: z.enum(["fixed", "range"]),
  /** Range only: the maximum is a ceiling. */
  capped: z.boolean(),
  /** Required on a recurring quote, absent on a project quote. */
  recurrence: recurrenceSchema.nullable(),
  /** Replaces the tiers for this scenario. */
  adjustmentOverride: percent.nullable(),
  /** Project quotes: when the (maximum) total is paid, in percent of it. */
  paymentSchedule: z.array(
    z.object({
      label: z.string().max(200),
      percent: z.number().min(0).max(100),
    }),
  ),
  lines: z.array(lineSchema),
});

export const rateSettingsSchema = z.object({
  /** This quote's own hourly rate per product, over the customer's and the default. */
  productRates: z.record(z.string(), z.number().min(0)),
  volumeTiers: z.array(z.object({ minHours: hours, percent })),
  termTiers: z.array(z.object({ minMonths: z.number().int().min(1), percent })),
});

export const quoteContentSchema = z
  .object({
    blocks: z.array(blockSchema),
    rates: rateSettingsSchema,
    displayUnit: z.enum(["hours", "days"]),
    hoursPerDay: z.number().gt(0).max(24),
    scenarios: z.array(scenarioSchema),
  })
  .superRefine((content, ctx) => {
    const seen = new Set<string>();
    const ids = [
      ...content.blocks.map((b) => b.id),
      ...content.scenarios.map((s) => s.id),
      ...content.scenarios.flatMap((s) => s.lines.map((l) => l.id)),
    ];
    for (const value of ids) {
      if (seen.has(value)) {
        ctx.addIssue({ code: "custom", message: `Duplicate id ${value}` });
      }
      seen.add(value);
    }

    if (content.blocks.filter((b) => b.type === "pricing").length > 1) {
      ctx.addIssue({
        code: "custom",
        message: "The scenarios appear in one place only",
        path: ["blocks"],
      });
    }

    if (content.blocks.filter((b) => b.type === "contents").length > 1) {
      ctx.addIssue({
        code: "custom",
        message: "A document lists its sections once",
        path: ["blocks"],
      });
    }
  });

export type EditorDoc = z.infer<typeof editorDocSchema>;
export type Block = z.infer<typeof blockSchema>;
export type Line = z.infer<typeof lineSchema>;
export type ItemLine = Extract<Line, { type: "item" }>;
export type Recurrence = z.infer<typeof recurrenceSchema>;
export type Scenario = z.infer<typeof scenarioSchema>;
export type RateSettings = z.infer<typeof rateSettingsSchema>;
export type QuoteContent = z.infer<typeof quoteContentSchema>;

export type QuoteKind = "project" | "recurring";

/**
 * Content as it may be stored for a quote of this kind. Throws a ZodError,
 * the same as a malformed shape, when a scenario's recurrence does not match
 * the kind: a recurring quote's scenarios each have one, a project quote's
 * have none.
 */
export function parseQuoteContent(
  value: unknown,
  kind: QuoteKind,
): QuoteContent {
  return quoteContentSchema
    .superRefine((content, ctx) => {
      for (const [index, scenario] of content.scenarios.entries()) {
        if (kind === "recurring" && scenario.recurrence === null) {
          ctx.addIssue({
            code: "custom",
            message: "A scenario on a recurring quote needs a period and term",
            path: ["scenarios", index, "recurrence"],
          });
        }
        if (kind === "project" && scenario.recurrence !== null) {
          ctx.addIssue({
            code: "custom",
            message: "A scenario on a project quote does not recur",
            path: ["scenarios", index, "recurrence"],
          });
        }
      }
    })
    .parse(value);
}

/**
 * What a new quote starts with: the team's default blocks, with a pricing
 * block after them when they have none, and no scenarios yet.
 */
export function initialQuoteContent(params: {
  defaultBlocks: Block[];
  hoursPerDay: number;
  newId: () => string;
}): QuoteContent {
  const blocks = params.defaultBlocks.map((block) => ({
    ...block,
    id: params.newId(),
  }));
  if (!blocks.some((b) => b.type === "pricing")) {
    blocks.push({ id: params.newId(), type: "pricing" });
  }
  // At the top, where a reader looks for it — and only on a new quote. A
  // quote written before there was such a block keeps the document it has;
  // its author adds one if they want it (FF-1668).
  if (!blocks.some((b) => b.type === "contents")) {
    blocks.unshift({ id: params.newId(), type: "contents" });
  }

  return {
    blocks,
    rates: { productRates: {}, volumeTiers: [], termTiers: [] },
    displayUnit: "hours",
    hoursPerDay: params.hoursPerDay,
    scenarios: [],
  };
}
