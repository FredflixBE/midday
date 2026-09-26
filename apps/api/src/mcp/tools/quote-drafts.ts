import { updateQuoteDraftSchema } from "@api/schemas/quotes";
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
  quoteContentSchema,
  type Recurrence,
  rateSettingsSchema,
  recurrenceSchema,
  removeScenario,
  type Scenario,
  scenarioSchema,
  type UnitSettings,
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
import { afterWrite, quoteIdInput, refused } from "./quotes";

/**
 * Pricing a draft through the MCP (FF-1790): its header, its scenarios, their
 * lines and the quote's own rates.
 *
 * A draft is stored as one `content` document whose ids tie it together: the
 * scenario an answer names, the optional lines that came along. So no tool
 * takes that document back from the model. Each one says what to change, and
 * the change is handed to `updateQuoteDraft` as an edit, made to the content
 * as it stands under the version's lock and checked as every save is. The
 * ids are made here; the model only ever names one it was given.
 *
 * The refusals here are about what was asked for, not what may be stored: a
 * cap on a fixed scenario, say, is a request the dashboard cannot even make,
 * because it only offers one where it applies. The stored rules stay in the
 * content schema and the query.
 */

type NewId = () => string;
type StoredQuote = NonNullable<Awaited<ReturnType<typeof getQuote>>>;
type Product = { id: string; name: string; isActive?: boolean | null };

const newId: NewId = () => crypto.randomUUID();

/**
 * The product a line names: by id, whatever its state, or by its name,
 * ignoring case, among the products that can still be picked — an inactive
 * one is hidden from the dashboard's picker too.
 */
export function resolveProduct(products: Product[], named: string): string {
  const byId = products.find((p) => p.id === named);
  if (byId) return byId.id;

  const active = products.filter((p) => p.isActive !== false);
  const wanted = named.trim().toLowerCase();
  const byName = active.filter((p) => p.name.toLowerCase() === wanted);
  if (byName.length === 1) return byName[0]!.id;
  if (byName.length > 1) {
    throw new QuoteInputError(
      `More than one product is called "${named}"; name it by id`,
    );
  }

  const known = active.map((p) => p.name).join(", ") || "none";
  throw new QuoteInputError(`No product "${named}". Products: ${known}`);
}

/** The draft's scenario of this id, or a refusal naming it. */
export function requireScenario(
  content: QuoteContent,
  scenarioId: string,
): Scenario {
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
    ? requireScenario(content, input.scenarioId)
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

/** Where an item line sits: what decides which of its fields apply. */
type ItemPlace = {
  scenario: Scenario;
  kind: QuoteKind;
  unit: UnitSettings;
};

function editItem(
  line: ItemLine,
  input: LineInput,
  place: ItemPlace,
  products: Product[],
): ItemLine {
  const next = { ...line };
  if (input.title !== undefined) next.title = input.title;
  if (input.description !== undefined) next.description = input.description;
  if (input.product !== undefined) {
    next.productId = resolveProduct(products, input.product);
  }
  if (input.quantityMax !== undefined) {
    if (input.quantityMax !== null && place.scenario.pricing !== "range") {
      throw new QuoteInputError(
        "A fixed scenario has no maximum; make the scenario a range first",
      );
    }
    next.hoursMax =
      input.quantityMax === null
        ? null
        : unitToHours(input.quantityMax, place.unit);
  }
  if (input.quantity !== undefined) {
    next.hours = unitToHours(input.quantity, place.unit);
    // A new minimum above the maximum lifts the maximum with it, as the
    // dashboard's field does. Both given the wrong way round is a mistake.
    if (next.hoursMax !== null && next.hours > next.hoursMax) {
      if (input.quantityMax != null) {
        throw new QuoteInputError(
          "The maximum quantity cannot be below the minimum",
        );
      }
      next.hoursMax = next.hours;
    }
  }
  if (input.optional !== undefined) next.optional = input.optional;
  if (input.once !== undefined) {
    if (input.once && place.kind !== "recurring") {
      throw new QuoteInputError(
        "Only a line on a recurring quote is charged once",
      );
    }
    next.once = input.once;
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
    scenario = requireScenario(content, input.scenarioId);
    line = newLine(input.type ?? "item", { newId: makeId });
    // The dashboard lets a line wait for its product; a line added here is
    // meant to be priced now, and one without a product prices nothing.
    if (line.type === "item" && input.product === undefined) {
      throw new QuoteInputError("A new item line needs a product");
    }
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
      line = editItem(line, input, { scenario, kind, unit: content }, products);
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
  volumeTiers?: { from: number; percent: number }[];
  termTiers?: QuoteContent["rates"]["termTiers"];
};

/**
 * The quote's own rates: an hourly rate per product over the customer's and
 * the default, null to fall back to those again; and the volume and term
 * tiers, each list replaced whole when given. A volume tier starts from a
 * quantity in the quote's unit, as the dashboard's does.
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
      volumeTiers:
        input.volumeTiers?.map((tier) => ({
          minHours: unitToHours(tier.from, content),
          percent: tier.percent,
        })) ?? content.rates.volumeTiers,
      termTiers: input.termTiers ?? content.rates.termTiers,
    },
  };
}

type Header = Pick<
  Parameters<typeof updateQuoteDraft>[1],
  "title" | "customerId" | "kind" | "language"
>;

/**
 * The header fields that would change something. A quote that has been sent
 * keeps its header and the query refuses any attempt at it, so a field given
 * as it already stands is dropped rather than refused.
 */
export function headerChanges(
  stored: { [K in keyof Header]-?: unknown },
  given: Header,
): Header {
  return Object.fromEntries(
    Object.entries(given).filter(
      ([key, value]) =>
        value !== undefined && value !== stored[key as keyof typeof stored],
    ),
  );
}

/** Changes the quote's draft, or says why there is none to change. */
async function editDraft(
  ctx: McpContext,
  quoteId: string,
  change: (
    quote: StoredQuote,
  ) => Omit<Parameters<typeof updateQuoteDraft>[1], "teamId" | "versionId">,
) {
  const quote = await getQuote(ctx.db, { id: quoteId, teamId: ctx.teamId });
  if (!quote) return refused("Quote not found");
  const draft = draftVersion(quote.versions);
  if (!draft) {
    return refused("This quote has no draft to change; revise it to start one");
  }

  return afterWrite(
    ctx,
    await updateQuoteDraft(ctx.db, {
      ...change(quote),
      teamId: ctx.teamId,
      versionId: draft.id,
    }),
  );
}

const header = updateQuoteDraftSchema.shape;
const contentFields = quoteContentSchema.shape;
const scenarioFields = scenarioSchema.shape;
const rateFields = rateSettingsSchema.shape;

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
        quoteId: quoteIdInput,
        title: header.title,
        customerId: header.customerId,
        kind: header.kind.describe(
          "Switching gives every scenario a period and term, or takes them away",
        ),
        language: header.language,
        mode: header.mode.describe(
          "estimate: non-binding; firm: a binding offer",
        ),
        issueDate: header.issueDate.describe("YYYY-MM-DD"),
        validUntil: header.validUntil.describe("YYYY-MM-DD"),
        internalNote: header.internalNote.describe(
          "Never printed; null clears it",
        ),
        displayUnit: contentFields.displayUnit
          .optional()
          .describe("Show and take quantities in hours or in days"),
        hoursPerDay: contentFields.hoursPerDay
          .optional()
          .describe("Hours in a day, when shown in days"),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    withErrorHandling(
      async ({
        quoteId,
        title,
        customerId,
        kind,
        language,
        displayUnit,
        hoursPerDay,
        ...rest
      }) =>
        editDraft(ctx, quoteId, (quote) => {
          const changed = headerChanges(quote, {
            title,
            customerId,
            kind,
            language,
          });
          const unitChange =
            displayUnit !== undefined || hoursPerDay !== undefined;
          const kindChange = changed.kind;
          return {
            ...rest,
            ...changed,
            edit:
              unitChange || kindChange
                ? (content) => {
                    const next = {
                      ...content,
                      displayUnit: displayUnit ?? content.displayUnit,
                      hoursPerDay: hoursPerDay ?? content.hoursPerDay,
                    };
                    return kindChange ? withKind(next, kindChange) : next;
                  }
                : undefined,
          };
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
        quoteId: quoteIdInput,
        scenarioId: z
          .string()
          .optional()
          .describe("The scenario to change; leave out to add one"),
        name: scenarioFields.name.optional(),
        recommended: z
          .boolean()
          .optional()
          .describe("Recommending one stops recommending the others"),
        pricing: scenarioFields.pricing
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
        recurrence: recurrenceSchema
          .partial()
          .optional()
          .describe(
            "Recurring quotes only: period, termMonths (null: indefinite), billing, autoRenew, noticeMonths; only what is given changes",
          ),
        adjustmentOverride: scenarioFields.adjustmentOverride
          .optional()
          .describe(
            "Percent on every rate in this scenario, replacing the volume and term tiers; negative is a discount; null goes back to the tiers",
          ),
        paymentSchedule: scenarioFields.paymentSchedule
          .optional()
          .describe(
            "Project quotes only: when the total is paid, in percent of it; replaces the schedule",
          ),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    withErrorHandling(
      async ({ quoteId, ...input }) =>
        editDraft(ctx, quoteId, (quote) => ({
          edit: (content) => upsertScenario(content, quote.kind, input).content,
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
      inputSchema: { quoteId: quoteIdInput, scenarioId: z.string() },
      annotations: WRITE_ANNOTATIONS,
    },
    withErrorHandling(
      async ({ quoteId, scenarioId }) =>
        editDraft(ctx, quoteId, () => ({
          edit: (content) => {
            requireScenario(content, scenarioId);
            return removeScenario(content, scenarioId);
          },
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
        quoteId: quoteIdInput,
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
            "Item only, and needed for a new one: the product by name or id; its hourly rate prices the line",
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
    withErrorHandling(async ({ quoteId, ...input }) => {
      const named = input.product === undefined ? [] : await products();
      return editDraft(ctx, quoteId, (quote) => ({
        edit: (content) =>
          upsertLine(content, quote.kind, input, named).content,
      }));
    }, "Failed to change the line"),
  );

  server.registerTool(
    "quotes_remove_line",
    {
      title: "Remove a Quote Line",
      description:
        "Remove a line from a quote's draft. Returns the quote as quotes_get does.",
      inputSchema: { quoteId: quoteIdInput, lineId: z.string() },
      annotations: WRITE_ANNOTATIONS,
    },
    withErrorHandling(
      async ({ quoteId, lineId }) =>
        editDraft(ctx, quoteId, () => ({
          edit: (content) => removeLine(content, lineId),
        })),
      "Failed to remove the line",
    ),
  );

  server.registerTool(
    "quotes_set_rates",
    {
      title: "Set a Quote's Rates",
      description:
        "Set a quote draft's own rates; quotes_get shows the ones it has. An hourly rate per product, in the quote's currency, goes before the customer's rate and the product's price; null takes it away again. Volume tiers adjust every rate once the committed quantity reaches a threshold, in the quote's unit; term tiers once a recurring scenario's term reaches a number of months. The volume and term adjustments add up, and a scenario's own adjustment replaces both. A list of tiers, when given, replaces the one there. Returns the quote as quotes_get does.",
      inputSchema: {
        quoteId: quoteIdInput,
        productRates: z
          .array(
            z.object({
              product: z.string().describe("Product by name or id"),
              hourlyRate: z.number().min(0).nullable(),
            }),
          )
          .optional(),
        volumeTiers: z
          .array(
            z.object({
              from: z
                .number()
                .min(0)
                .describe("Committed quantity, in the quote's unit"),
              percent: rateFields.volumeTiers.element.shape.percent,
            }),
          )
          .optional()
          .describe("Percent on every rate from this committed quantity on"),
        termTiers: rateFields.termTiers
          .optional()
          .describe("Percent on every rate from a term of this many months on"),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    withErrorHandling(async ({ quoteId, ...input }) => {
      const named = input.productRates?.length ? await products() : [];
      return editDraft(ctx, quoteId, () => ({
        edit: (content) => setRates(content, input, named),
      }));
    }, "Failed to set the rates"),
  );
};
