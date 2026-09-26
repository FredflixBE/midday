import {
  getQuote,
  getQuoteProducts,
  QuoteInputError,
  updateQuoteDraft,
} from "@midday/db/queries";
import {
  draftVersion,
  type ItemLine,
  type Line,
  markRecommended,
  newLine,
  newScenario,
  type QuoteContent,
  type QuoteKind,
  type Recurrence,
  type Scenario,
  unitToHours,
  withKind,
  withPricing,
} from "@midday/quote";
import { z } from "zod";
import {
  hasScope,
  type McpContext,
  type RegisterTools,
  WRITE_ANNOTATIONS,
} from "../types";
import { withErrorHandling } from "../utils";
import { afterWrite, refused } from "./quotes";

/**
 * Pricing a draft through the MCP (FF-1790): its header, its scenarios, their
 * lines and the quote's own rates.
 *
 * A draft is stored as one `content` document whose ids tie it together: the
 * scenario an answer names, the optional lines that came along. So no tool
 * takes that document back from the model. Each one says what to change, the
 * change is made here to the draft as it is stored, and the whole goes back
 * through `updateQuoteDraft`, which checks it as it checks every save. The
 * ids are made here; the model only ever names one it was given.
 */

type NewId = () => string;
type Product = { id: string; name: string };

const newId: NewId = () => crypto.randomUUID();

/** The product a line names, by id or by its name, ignoring case. */
export function resolveProduct(products: Product[], named: string): string {
  const byId = products.find((p) => p.id === named);
  if (byId) return byId.id;

  const wanted = named.trim().toLowerCase();
  const byName = products.filter((p) => p.name.toLowerCase() === wanted);
  if (byName.length === 1) return byName[0]!.id;
  if (byName.length > 1) {
    throw new QuoteInputError(
      `More than one product is called "${named}"; name it by id`,
    );
  }

  const known = products.map((p) => p.name).join(", ") || "none";
  throw new QuoteInputError(`No product "${named}". Products: ${known}`);
}

function scenarioIn(content: QuoteContent, scenarioId: string): Scenario {
  const scenario = content.scenarios.find((s) => s.id === scenarioId);
  if (!scenario) {
    throw new QuoteInputError(`This draft has no scenario ${scenarioId}`);
  }
  return scenario;
}

const replaceScenario = (content: QuoteContent, scenario: Scenario) => ({
  ...content,
  scenarios: content.scenarios.map((s) =>
    s.id === scenario.id ? scenario : s,
  ),
});

export type ScenarioInput = {
  scenarioId?: string;
  name?: string;
  recommended?: boolean;
  pricing?: Scenario["pricing"];
  capped?: boolean;
  recurrence?: Partial<Recurrence>;
  adjustmentOverride?: number | null;
  paymentSchedule?: Scenario["paymentSchedule"];
};

/**
 * A scenario added, or one of the draft's changed: only what the input names
 * changes. Refuses what a scenario of this quote's kind cannot have, in
 * words, rather than leaving it to the schema's.
 */
export function upsertScenario(
  content: QuoteContent,
  kind: QuoteKind,
  input: ScenarioInput,
  makeId: NewId = newId,
): { content: QuoteContent; scenarioId: string } {
  const existing = input.scenarioId
    ? scenarioIn(content, input.scenarioId)
    : null;
  let scenario =
    existing ??
    newScenario({ kind, name: input.name ?? "Scenario", newId: makeId });

  if (input.name !== undefined) scenario = { ...scenario, name: input.name };
  if (input.pricing !== undefined) {
    scenario = withPricing(scenario, input.pricing);
  }
  if (input.capped !== undefined) {
    if (input.capped && scenario.pricing !== "range") {
      throw new QuoteInputError("Only a range scenario can be capped");
    }
    scenario = { ...scenario, capped: input.capped };
  }
  if (input.recurrence !== undefined) {
    if (kind !== "recurring" || !scenario.recurrence) {
      throw new QuoteInputError("A scenario on a project quote does not recur");
    }
    scenario = {
      ...scenario,
      recurrence: { ...scenario.recurrence, ...input.recurrence },
    };
  }
  if (input.adjustmentOverride !== undefined) {
    scenario = { ...scenario, adjustmentOverride: input.adjustmentOverride };
  }
  if (input.paymentSchedule !== undefined) {
    if (kind !== "project") {
      throw new QuoteInputError("Only a project quote has a payment schedule");
    }
    scenario = { ...scenario, paymentSchedule: input.paymentSchedule };
  }

  let next = existing
    ? replaceScenario(content, scenario)
    : { ...content, scenarios: [...content.scenarios, scenario] };
  if (input.recommended !== undefined) {
    next = markRecommended(next, scenario.id, input.recommended);
  }
  return { content: next, scenarioId: scenario.id };
}

export function removeScenario(
  content: QuoteContent,
  scenarioId: string,
): QuoteContent {
  scenarioIn(content, scenarioId);
  return {
    ...content,
    scenarios: content.scenarios.filter((s) => s.id !== scenarioId),
  };
}

export type LineInput = {
  scenarioId?: string;
  lineId?: string;
  type?: Line["type"];
  title?: string;
  description?: string | null;
  text?: string;
  product?: string;
  quantity?: number;
  quantityMax?: number | null;
  optional?: boolean;
  once?: boolean;
  index?: number;
};

/** What a line can be given, of which each kind takes its own share. */
const LINE_INPUTS = [
  "title",
  "description",
  "text",
  "product",
  "quantity",
  "quantityMax",
  "optional",
  "once",
] as const satisfies (keyof LineInput)[];

/** What each kind of line holds besides its id; the rest does not apply. */
const LINE_FIELDS: Record<Line["type"], (typeof LINE_INPUTS)[number][]> = {
  section: ["title"],
  note: ["text"],
  item: [
    "title",
    "description",
    "product",
    "quantity",
    "quantityMax",
    "optional",
    "once",
  ],
};

function lineIn(content: QuoteContent, lineId: string) {
  for (const scenario of content.scenarios) {
    const line = scenario.lines.find((l) => l.id === lineId);
    if (line) return { scenario, line };
  }
  throw new QuoteInputError(`This draft has no line ${lineId}`);
}

function editItem(
  line: ItemLine,
  input: LineInput,
  context: {
    scenario: Scenario;
    kind: QuoteKind;
    unit: QuoteContent;
    products: Product[];
  },
): ItemLine {
  const next = { ...line };
  if (input.title !== undefined) next.title = input.title;
  if (input.description !== undefined) next.description = input.description;
  if (input.product !== undefined) {
    next.productId = resolveProduct(context.products, input.product);
  }
  if (input.quantity !== undefined) {
    next.hours = unitToHours(input.quantity, context.unit);
  }
  if (input.quantityMax !== undefined) {
    if (input.quantityMax !== null && context.scenario.pricing !== "range") {
      throw new QuoteInputError(
        "A fixed scenario has no maximum; make the scenario a range first",
      );
    }
    next.hoursMax =
      input.quantityMax === null
        ? null
        : unitToHours(input.quantityMax, context.unit);
  }
  if (input.optional !== undefined) next.optional = input.optional;
  if (input.once !== undefined) {
    if (input.once && context.kind !== "recurring") {
      throw new QuoteInputError(
        "Only a line on a recurring quote is charged once",
      );
    }
    next.once = input.once;
  }
  if (!next.productId) {
    throw new QuoteInputError("An item line needs a product");
  }
  return next;
}

/**
 * A line added to a scenario, or one of the draft's changed, and placed at
 * `index` when one is given. Quantities are in the quote's unit, as
 * `quotes_get` shows them, and stored as hours.
 */
export function upsertLine(
  content: QuoteContent,
  kind: QuoteKind,
  input: LineInput,
  products: Product[],
  makeId: NewId = newId,
): { content: QuoteContent; lineId: string } {
  let scenario: Scenario;
  let line: Line;

  if (input.lineId) {
    const found = lineIn(content, input.lineId);
    if (input.scenarioId && input.scenarioId !== found.scenario.id) {
      throw new QuoteInputError(
        "A line stays in its scenario; remove it and add it to the other",
      );
    }
    if (input.type && input.type !== found.line.type) {
      throw new QuoteInputError(
        `Line ${input.lineId} is a ${found.line.type}; its type does not change`,
      );
    }
    scenario = found.scenario;
    line = found.line;
  } else {
    if (!input.scenarioId) {
      throw new QuoteInputError("A new line needs the scenario it goes in");
    }
    scenario = scenarioIn(content, input.scenarioId);
    line = newLine(input.type ?? "item", { newId: makeId });
  }

  const allowed = LINE_FIELDS[line.type];
  const stray = LINE_INPUTS.filter(
    (key) => input[key] !== undefined && !allowed.includes(key),
  );
  if (stray.length > 0) {
    const article = line.type === "item" ? "An" : "A";
    throw new QuoteInputError(
      `${article} ${line.type} line has no ${stray.join(", ")}`,
    );
  }

  switch (line.type) {
    case "section":
      if (input.title !== undefined) line = { ...line, title: input.title };
      break;
    case "note":
      if (input.text !== undefined) line = { ...line, text: input.text };
      break;
    case "item":
      line = editItem(line, input, { scenario, kind, unit: content, products });
      break;
  }

  const lines = scenario.lines.filter((l) => l.id !== line.id);
  const at =
    input.index !== undefined
      ? Math.min(Math.max(input.index, 0), lines.length)
      : input.lineId
        ? scenario.lines.findIndex((l) => l.id === line.id)
        : lines.length;
  lines.splice(at, 0, line);

  return {
    content: replaceScenario(content, { ...scenario, lines }),
    lineId: line.id,
  };
}

export function removeLine(content: QuoteContent, lineId: string) {
  const { scenario } = lineIn(content, lineId);
  return replaceScenario(content, {
    ...scenario,
    lines: scenario.lines.filter((l) => l.id !== lineId),
  });
}

export type RatesInput = {
  productRates?: { product: string; hourlyRate: number | null }[];
  volumeTiers?: QuoteContent["rates"]["volumeTiers"];
  termTiers?: QuoteContent["rates"]["termTiers"];
};

/**
 * The quote's own rates: an hourly rate per product over the customer's and
 * the default, null to fall back to those again; and the volume and term
 * tiers, each list replaced whole when given.
 */
export function setRates(
  content: QuoteContent,
  input: RatesInput,
  products: Product[],
): QuoteContent {
  const productRates = { ...content.rates.productRates };
  for (const { product, hourlyRate } of input.productRates ?? []) {
    const id = resolveProduct(products, product);
    if (hourlyRate === null) delete productRates[id];
    else productRates[id] = hourlyRate;
  }

  return {
    ...content,
    rates: {
      productRates,
      volumeTiers: input.volumeTiers ?? content.rates.volumeTiers,
      termTiers: input.termTiers ?? content.rates.termTiers,
    },
  };
}

/** Changes the quote's draft, or says why there is none to change. */
async function editDraft(
  ctx: McpContext,
  quoteId: string,
  edit: (draft: {
    content: QuoteContent;
    kind: QuoteKind;
  }) => Promise<
    Omit<Parameters<typeof updateQuoteDraft>[1], "teamId" | "versionId">
  >,
) {
  const quote = await getQuote(ctx.db, { id: quoteId, teamId: ctx.teamId });
  if (!quote) return refused("Quote not found");
  const draft = draftVersion(quote.versions);
  if (!draft) {
    return refused("This quote has no draft to change; revise it to start one");
  }

  const change = await edit({
    content: draft.content as QuoteContent,
    kind: quote.kind,
  });
  return afterWrite(
    ctx,
    await updateQuoteDraft(ctx.db, {
      ...change,
      teamId: ctx.teamId,
      versionId: draft.id,
    }),
  );
}

const quoteId = z.string().uuid().describe("Quote ID");
const percent = z.number().gt(-100).max(1000);

export const registerQuoteDraftTools: RegisterTools = (server, ctx) => {
  if (!hasScope(ctx, "invoices.write")) return;

  const products = () => getQuoteProducts(ctx.db, ctx.teamId);

  server.registerTool(
    "quotes_update_draft",
    {
      title: "Update Quote Draft",
      description:
        "Change the header of a quote's draft: title, customer, kind and language (only before the quote is first sent), mode, issue and expiry dates, the internal note, and whether quantities are shown in hours or days. Only what is given changes. Returns the quote as quotes_get does.",
      inputSchema: {
        quoteId,
        title: z.string().trim().min(1).max(300).optional(),
        customerId: z.string().uuid().optional(),
        kind: z
          .enum(["project", "recurring"])
          .optional()
          .describe(
            "Switching gives every scenario a period and term, or takes them away",
          ),
        language: z.enum(["nl", "en"]).optional(),
        mode: z
          .enum(["estimate", "firm"])
          .optional()
          .describe("estimate: non-binding; firm: a binding offer"),
        issueDate: z.iso.date().optional().describe("YYYY-MM-DD"),
        validUntil: z.iso.date().optional().describe("YYYY-MM-DD"),
        internalNote: z
          .string()
          .max(10_000)
          .nullable()
          .optional()
          .describe("Never printed; null clears it"),
        displayUnit: z
          .enum(["hours", "days"])
          .optional()
          .describe("Show and take quantities in hours or in days"),
        hoursPerDay: z
          .number()
          .gt(0)
          .max(24)
          .optional()
          .describe("Hours in a day, when shown in days"),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    withErrorHandling(
      async ({ quoteId, kind, displayUnit, hoursPerDay, ...header }) =>
        editDraft(ctx, quoteId, async (draft) => {
          const unitChange =
            displayUnit !== undefined || hoursPerDay !== undefined;
          let content: QuoteContent | undefined;
          if (unitChange || kind !== undefined) {
            content = {
              ...draft.content,
              displayUnit: displayUnit ?? draft.content.displayUnit,
              hoursPerDay: hoursPerDay ?? draft.content.hoursPerDay,
            };
            if (kind !== undefined) content = withKind(content, kind);
          }
          return { ...header, kind, content };
        }),
      "Failed to update quote draft",
    ),
  );

  server.registerTool(
    "quotes_upsert_scenario",
    {
      title: "Add or Change a Quote Scenario",
      description:
        "Add a scenario to a quote's draft (leave scenarioId out), or change one (give its id from quotes_get). A scenario is one way the work could be done and priced: fixed hours, or a range from a minimum to a maximum that can be capped. On a recurring quote it has a period, term, billing and notice; on a project quote a payment schedule. Only what is given changes. Returns the quote as quotes_get does.",
      inputSchema: {
        quoteId,
        scenarioId: z
          .string()
          .optional()
          .describe("The scenario to change; leave out to add one"),
        name: z.string().max(200).optional(),
        recommended: z
          .boolean()
          .optional()
          .describe("Recommending one stops recommending the others"),
        pricing: z
          .enum(["fixed", "range"])
          .optional()
          .describe(
            "fixed: one number of hours per line; range: a minimum and a maximum",
          ),
        capped: z
          .boolean()
          .optional()
          .describe(
            "Range only: the maximum is a ceiling the client pays at most",
          ),
        recurrence: z
          .object({
            period: z.enum(["month", "quarter", "year"]).optional(),
            termMonths: z
              .number()
              .int()
              .min(1)
              .max(1200)
              .nullable()
              .optional()
              .describe("null: an indefinite term"),
            billing: z.enum(["in_advance", "in_arrears"]).optional(),
            autoRenew: z.boolean().optional(),
            noticeMonths: z
              .number()
              .int()
              .min(0)
              .max(120)
              .nullable()
              .optional(),
          })
          .optional()
          .describe("Recurring quotes only; only what is given changes"),
        adjustmentOverride: percent
          .nullable()
          .optional()
          .describe(
            "Percent on every rate in this scenario, replacing the volume and term tiers; negative is a discount; null goes back to the tiers",
          ),
        paymentSchedule: z
          .array(
            z.object({
              label: z.string().max(200),
              percent: z.number().min(0).max(100),
            }),
          )
          .optional()
          .describe(
            "Project quotes only: when the total is paid, in percent of it; replaces the schedule",
          ),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    withErrorHandling(
      async ({ quoteId, ...input }) =>
        editDraft(ctx, quoteId, async (draft) => ({
          content: upsertScenario(draft.content, draft.kind, input).content,
        })),
      "Failed to change the scenario",
    ),
  );

  server.registerTool(
    "quotes_remove_scenario",
    {
      title: "Remove a Quote Scenario",
      description:
        "Remove a scenario, with its lines, from a quote's draft. Returns the quote as quotes_get does.",
      inputSchema: { quoteId, scenarioId: z.string() },
      annotations: WRITE_ANNOTATIONS,
    },
    withErrorHandling(
      async ({ quoteId, scenarioId }) =>
        editDraft(ctx, quoteId, async (draft) => ({
          content: removeScenario(draft.content, scenarioId),
        })),
      "Failed to remove the scenario",
    ),
  );

  server.registerTool(
    "quotes_upsert_line",
    {
      title: "Add or Change a Quote Line",
      description:
        "Add a line to a scenario of a quote's draft (give scenarioId, leave lineId out), or change one (give its lineId from quotes_get). An item is work priced by a product's hourly rate; a section heads the items under it; a note is a remark. Quantities are in the quote's unit: days when it is shown in days, else hours. Only what is given changes; index moves the line to that position in its scenario, counted from 0. Returns the quote as quotes_get does.",
      inputSchema: {
        quoteId,
        scenarioId: z
          .string()
          .optional()
          .describe("The scenario a new line goes in"),
        lineId: z
          .string()
          .optional()
          .describe("The line to change; leave out to add one"),
        type: z
          .enum(["item", "section", "note"])
          .optional()
          .describe("A new line's type; item when left out"),
        title: z.string().max(500).optional().describe("Item or section"),
        description: z
          .string()
          .max(5000)
          .nullable()
          .optional()
          .describe("Item only"),
        text: z.string().max(5000).optional().describe("Note only"),
        product: z
          .string()
          .optional()
          .describe(
            "Item only: the product by name or id; its hourly rate prices the line",
          ),
        quantity: z
          .number()
          .min(0)
          .optional()
          .describe(
            "Item only: in the quote's unit; a range scenario's minimum",
          ),
        quantityMax: z
          .number()
          .min(0)
          .nullable()
          .optional()
          .describe("Item on a range scenario only: the maximum"),
        optional: z
          .boolean()
          .optional()
          .describe("Item only: priced and shown, left out of the totals"),
        once: z
          .boolean()
          .optional()
          .describe("Item on a recurring quote only: charged once"),
        index: z.number().int().min(0).optional(),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    withErrorHandling(
      async ({ quoteId, ...input }) =>
        editDraft(ctx, quoteId, async (draft) => ({
          content: upsertLine(
            draft.content,
            draft.kind,
            input,
            input.product === undefined ? [] : await products(),
          ).content,
        })),
      "Failed to change the line",
    ),
  );

  server.registerTool(
    "quotes_remove_line",
    {
      title: "Remove a Quote Line",
      description:
        "Remove a line from a quote's draft. Returns the quote as quotes_get does.",
      inputSchema: { quoteId, lineId: z.string() },
      annotations: WRITE_ANNOTATIONS,
    },
    withErrorHandling(
      async ({ quoteId, lineId }) =>
        editDraft(ctx, quoteId, async (draft) => ({
          content: removeLine(draft.content, lineId),
        })),
      "Failed to remove the line",
    ),
  );

  server.registerTool(
    "quotes_set_rates",
    {
      title: "Set a Quote's Rates",
      description:
        "Set a quote draft's own rates. An hourly rate per product, in the quote's currency, goes before the customer's rate and the product's price; null takes it away again. Volume tiers adjust every rate once the committed hours reach a threshold; term tiers once a recurring scenario's term reaches a number of months. The volume and term adjustments add up, and a scenario's own adjustment replaces both. A list of tiers, when given, replaces the one there. Returns the quote as quotes_get does.",
      inputSchema: {
        quoteId,
        productRates: z
          .array(
            z.object({
              product: z.string().describe("Product by name or id"),
              hourlyRate: z.number().min(0).nullable(),
            }),
          )
          .optional(),
        volumeTiers: z
          .array(z.object({ minHours: z.number().min(0), percent }))
          .optional()
          .describe("Percent from this many committed hours on"),
        termTiers: z
          .array(z.object({ minMonths: z.number().int().min(1), percent }))
          .optional()
          .describe("Percent from a term of this many months on"),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    withErrorHandling(
      async ({ quoteId, ...input }) =>
        editDraft(ctx, quoteId, async (draft) => ({
          content: setRates(
            draft.content,
            input,
            input.productRates?.length ? await products() : [],
          ),
        })),
      "Failed to set the rates",
    ),
  );
};
