import {
  acceptQuoteSchema,
  createQuoteSchema,
  markQuoteSentSchema,
  setQuoteOutcomeSchema,
} from "@api/schemas/quotes";
import { storeQuotePdf } from "@api/services/quote-pdf";
import {
  acceptQuoteVersion,
  createQuote,
  getPricedQuote,
  getQuote,
  listQuotes,
  markQuoteVersionSent,
  reviseQuote,
  setQuoteOutcome,
  undoQuoteAcceptance,
} from "@midday/db/queries";
import {
  type Amount,
  acceptedVersion,
  type Block,
  draftVersion,
  heldVersion,
  hoursToUnit,
  type QuoteContent,
  quoteState,
  type ScenarioPricing,
} from "@midday/quote";
import { editorDocToMarkdown } from "@midday/ui/editor/markdown";
import { z } from "zod";
import {
  DESTRUCTIVE_ANNOTATIONS,
  hasScope,
  type McpContext,
  READ_ONLY_ANNOTATIONS,
  type RegisterTools,
  WRITE_ANNOTATIONS,
} from "../types";
import { DASHBOARD_URL, withErrorHandling } from "../utils";

/**
 * Quotes for the assistant (FF-1618): the list with the filters of the list
 * page, one quote with every version priced, and what awaits an answer.
 * Amounts are in the quote's currency, excluding VAT; the database keeps
 * cents. Reading quotes goes with reading invoices: the same scope.
 *
 * And moving a quote through its life (FF-1789): create, revise, mark sent,
 * accept, take an acceptance back, lost or no decision. Writing goes with
 * writing invoices. Each tool names the quote, never a version: which version
 * a step applies to is the quote's to say, so it is looked up here. The rules
 * stay in the queries, which check them again under a lock.
 */

type ListRow = Awaited<ReturnType<typeof listQuotes>>[number];
type PricedQuote = NonNullable<Awaited<ReturnType<typeof getPricedQuote>>>;
type StoredQuote = NonNullable<Awaited<ReturnType<typeof getQuote>>>;

export const QUOTE_FILTERS = [
  "draft",
  "awaiting",
  "expiring",
  "expired",
  "won",
  "lost",
] as const;

/** The UTC date, the rule `isExpired` and the list filters read by. */
export function todayUtc(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** Whole days from one `YYYY-MM-DD` date to another. */
export function daysBetween(from: string, to: string) {
  const day = (date: string) => Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
  return Math.round((day(to) - day(from)) / 86_400_000);
}

const money = (cents: number) => cents / 100;
const amount = (value: Amount) => ({
  amount: money(value.amount),
  max: value.max === null ? null : money(value.max),
});

const quoteUrl = (id: string) => `${DASHBOARD_URL}/quotes/${id}`;

export function quoteListItem(row: ListRow) {
  return {
    id: row.id,
    quoteNumber: row.quoteNumber,
    title: row.title,
    customerName: row.customerName,
    kind: row.kind,
    currency: row.currency,
    state: quoteState(row, row.version, row.held),
    outcome: row.outcome,
    outcomeReason: row.outcomeReason,
    latestVersion: {
      version: row.version.version,
      status: row.version.status,
      mode: row.version.mode,
      issueDate: row.version.issueDate,
      validUntil: row.version.validUntil,
    },
    /** The version the client holds; null before one is sent. */
    held: row.held
      ? {
          version: row.held.version,
          sentAt: row.held.sentAt,
          sentTo: row.held.sentTo,
          validUntil: row.held.validUntil,
          expired: row.held.expired,
        }
      : null,
    /** The one amount the list shows; `per` is "total" or "year". */
    headline: row.headline
      ? { ...amount(row.headline.amount), per: row.headline.per }
      : null,
    url: quoteUrl(row.id),
  };
}

/** A quote sent and not answered: how long ago it went, how long it holds. */
export function awaitingItem(row: ListRow, today: string) {
  const held = row.held!;
  return {
    ...quoteListItem(row),
    daysSinceSent: held.sentAt ? daysBetween(held.sentAt, today) : null,
    daysUntilExpiry: daysBetween(today, held.validUntil),
  };
}

function scenarioDetail(
  scenario: QuoteContent["scenarios"][number],
  priced: ScenarioPricing | undefined,
  unit: QuoteContent,
  productNames: Record<string, string>,
) {
  const lines = new Map(priced?.lines.map((l) => [l.lineId, l]));
  const totals = priced?.totals;

  return {
    id: scenario.id,
    name: scenario.name,
    recommended: scenario.recommended,
    pricing: scenario.pricing,
    capped: scenario.capped,
    recurrence: scenario.recurrence,
    /** In percent, on every rate; a negative number is a discount. */
    adjustment: priced?.adjustment ?? 0,
    /** This scenario's own adjustment, over the tiers; null when it has none. */
    adjustmentOverride: scenario.adjustmentOverride,
    lines: scenario.lines.map((line) => {
      if (line.type !== "item") return line;
      const p = lines.get(line.id);
      return {
        id: line.id,
        type: line.type,
        title: line.title,
        description: line.description,
        product: productNames[line.productId] ?? null,
        hours: line.hours,
        hoursMax: line.hoursMax,
        /** In the quote's unit: days when it is shown in days. */
        quantity: hoursToUnit(line.hours, unit),
        quantityMax:
          line.hoursMax === null ? null : hoursToUnit(line.hoursMax, unit),
        hourlyRate: p?.rate == null ? null : money(p.rate),
        amount: p ? money(p.amount) : null,
        amountMax: p?.amountMax == null ? null : money(p.amountMax),
        optional: line.optional,
        once: line.once,
      };
    }),
    totals: !totals
      ? null
      : totals.kind === "project"
        ? {
            total: amount(totals.total),
            hours: totals.hours,
            capped: totals.capped,
          }
        : {
            perPeriod: amount(totals.perPeriod),
            perYear: amount(totals.perYear),
            overTerm: totals.overTerm ? amount(totals.overTerm) : null,
            oneOff: amount(totals.oneOff),
            contractValue: amount(totals.contractValue),
            capped: totals.capped,
          },
    paymentSchedule: (priced?.paymentSchedule ?? []).map((p) => ({
      label: p.label,
      percent: p.percent,
      amount: money(p.amount),
    })),
  };
}

/** A block as `quotes_get` shows it. */
export function blockDetail(block: Block) {
  if (block.type !== "text") return { id: block.id, type: block.type };

  let read: { markdown: string | null; exact: boolean };
  try {
    read = editorDocToMarkdown(block.body);
  } catch {
    // Saved by a build that knew a node this one does not.
    read = { markdown: null, exact: false };
  }
  return {
    id: block.id,
    type: block.type,
    heading: block.heading,
    markdown: read.markdown,
    /** Whether the markdown says the whole body, and so can be written back. */
    editable: read.exact,
  };
}

/**
 * The quote's own rates, as `quotes_set_rates` takes them: hourly rates by
 * product, and volume tiers from a quantity in the quote's unit.
 */
function ratesDetail(
  content: QuoteContent,
  productNames: Record<string, string>,
) {
  return {
    productRates: Object.entries(content.rates.productRates).map(
      ([productId, hourlyRate]) => ({
        product: productNames[productId] ?? null,
        productId,
        hourlyRate,
      }),
    ),
    volumeTiers: content.rates.volumeTiers.map((tier) => ({
      from: hoursToUnit(tier.minHours, content),
      percent: tier.percent,
    })),
    termTiers: content.rates.termTiers,
  };
}

export function quoteDetail(quote: PricedQuote) {
  const held = heldVersion(quote.versions) ?? null;
  const latest = quote.versions[0]!;

  return {
    id: quote.id,
    quoteNumber: quote.quoteNumber,
    title: quote.title,
    customerName: quote.customerName,
    kind: quote.kind,
    language: quote.language,
    currency: quote.currency,
    state: quoteState(quote, latest, held),
    outcome: quote.outcome,
    outcomeReason: quote.outcomeReason,
    outcomeAt: quote.outcomeAt,
    /** The tracker project an accepted quote opened. */
    trackerProjectId: quote.trackerProjectId,
    url: quoteUrl(quote.id),
    /** Newest first. */
    versions: quote.versions.map((version) => {
      const priced = new Map(
        version.pricing.scenarios.map((s) => [s.scenarioId, s]),
      );
      return {
        id: version.id,
        version: version.version,
        status: version.status,
        mode: version.mode,
        issueDate: version.issueDate,
        validUntil: version.validUntil,
        expired: version.expired,
        sentAt: version.sentAt,
        sentTo: version.sentTo,
        /** What the client said yes to; null unless this version is accepted. */
        acceptance:
          version.status === "accepted"
            ? {
                scenarioId: version.acceptedScenarioId,
                optionalLineIds: version.acceptedOptionalLineIds ?? [],
                acceptedAt: version.acceptedAt,
                acceptedByName: version.acceptedByName,
                poNumber: version.poNumber,
              }
            : null,
        displayUnit: version.content.displayUnit,
        hoursPerDay: version.content.hoursPerDay,
        rates: ratesDetail(version.content, quote.productNames),
        /** The text, in order; `pricing` marks where the scenarios appear. */
        blocks: version.content.blocks.map(blockDetail),
        scenarios: version.content.scenarios.map((scenario) =>
          scenarioDetail(
            scenario,
            priced.get(scenario.id),
            version.content,
            quote.productNames,
          ),
        ),
      };
    }),
  };
}

type Answer = {
  scenarioId: string;
  optionalLineIds?: string[];
  acceptedAt?: string;
  acceptedByName?: string | null;
  poNumber?: string | null;
};

/**
 * What to record for an answer. Recording one again replaces the whole
 * record, so on an accepted version what the call leaves out stays as it was:
 * the order form, which this tool cannot attach, and the rest of what was
 * recorded. Null clears. The optional lines are kept only for the same
 * scenario, since they belong to it.
 */
function answerToRecord(held: StoredQuote["versions"][number], answer: Answer) {
  if (held.status !== "accepted") return answer;

  const kept = <T>(given: T | undefined, recorded: T) =>
    given === undefined ? recorded : given;
  const sameScenario = answer.scenarioId === held.acceptedScenarioId;
  return {
    scenarioId: answer.scenarioId,
    optionalLineIds: kept(
      answer.optionalLineIds,
      sameScenario ? (held.acceptedOptionalLineIds ?? []) : [],
    ),
    acceptedAt: kept(answer.acceptedAt, held.acceptedAt ?? undefined),
    acceptedByName: kept(answer.acceptedByName, held.acceptedByName),
    poNumber: kept(answer.poNumber, held.poNumber),
    acceptanceFilePath: held.acceptanceFilePath,
  };
}

export const quoteIdInput = z.string().uuid().describe("Quote ID");

/** A refusal, said to the model in the words it can act on. */
export const refused = (text: string) => ({
  content: [{ type: "text" as const, text }],
  isError: true as const,
});

/** The quote as it now stands, shaped as `quotes_get` shapes it. */
async function pricedQuote(ctx: McpContext, id: string) {
  const quote = await getPricedQuote(ctx.db, {
    id,
    teamId: ctx.teamId,
    today: todayUtc(),
  });
  if (!quote) return refused("Quote not found");

  const data = quoteDetail(quote);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: { data },
  };
}

/** A write's answer: the quote it left behind, or why there is none. */
export async function afterWrite(
  ctx: McpContext,
  written: { id: string } | null,
  missing = "Quote not found",
) {
  return written ? pricedQuote(ctx, written.id) : refused(missing);
}

const registerReadTools: RegisterTools = (server, ctx) => {
  const { db, teamId } = ctx;

  server.registerTool(
    "quotes_list",
    {
      title: "List Quotes",
      description:
        "List quotes (proposals priced in hours, sent as a PDF), newest first, with the filters of the Quotes page: draft (the latest version is a draft), awaiting (sent, still valid, no answer recorded), expiring (awaiting and valid for at most 7 more days), expired (the version sent is past its validity, no answer), won, lost. Each quote has its state, the version the client holds and one headline amount, in the quote's currency excluding VAT.",
      inputSchema: {
        status: z
          .enum(QUOTE_FILTERS)
          .optional()
          .describe("Filter; leave out for every quote"),
      },
      outputSchema: {
        data: z.array(z.record(z.string(), z.any())),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    withErrorHandling(async ({ status }) => {
      const rows = await listQuotes(db, { teamId, status, today: todayUtc() });
      const data = rows.map(quoteListItem);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
        structuredContent: { data },
      };
    }, "Failed to list quotes"),
  );

  server.registerTool(
    "quotes_get",
    {
      title: "Get Quote",
      description:
        "Get one quote with all its versions, newest first. Each version has its status, mode, dates, who it was sent to, and its scenarios with their lines (named by product), rates, totals and payment schedule. A sent version is priced as it was sent; a draft at today's rates. Amounts are in the quote's currency excluding VAT; quantities are hours, and also in the quote's unit (days when it is shown in days). Each version also has the quote's own rates (hourly rates by product, volume and term tiers) and its text: blocks in order, a text block's body as markdown, with pricing and contents marking where the scenarios and the list of sections appear. Versions, scenarios and lines carry the ids the quote write tools take; an accepted version says what was accepted.",
      inputSchema: {
        id: z.string().uuid().describe("Quote ID"),
      },
      outputSchema: {
        data: z.record(z.string(), z.any()),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    withErrorHandling(
      async ({ id }) => pricedQuote(ctx, id),
      "Failed to get quote",
    ),
  );

  server.registerTool(
    "quotes_awaiting_answer",
    {
      title: "Quotes Awaiting an Answer",
      description:
        "Quotes sent and not answered while the version the client holds is still valid, the soonest to expire first, with the days since sending and the days until expiry. A quote being revised still counts while the version the client holds is valid. Use it to decide which client to follow up.",
      inputSchema: {},
      outputSchema: {
        data: z.array(z.record(z.string(), z.any())),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    withErrorHandling(async () => {
      const today = todayUtc();
      const rows = await listQuotes(db, { teamId, status: "awaiting", today });
      const data = rows
        .map((row) => awaitingItem(row, today))
        .sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
        structuredContent: { data },
      };
    }, "Failed to list quotes awaiting an answer"),
  );
};

const create = createQuoteSchema.shape;
const accept = acceptQuoteSchema.shape;

const registerWriteTools: RegisterTools = (server, ctx) => {
  const { db, teamId, userId } = ctx;

  /** The quote to act on, or the tool's answer when there is none. */
  const load = (id: string) => getQuote(db, { id, teamId });

  server.registerTool(
    "quotes_create",
    {
      title: "Create Quote",
      description:
        "Create a quote for a customer, with version 1 as a draft: numbered, the team's default text blocks copied in, issued today and valid for the team's default number of days. A project quote is priced once; a recurring quote per month, quarter or year. The draft has no scenarios yet. Returns the quote as quotes_get does.",
      inputSchema: {
        customerId: create.customerId.describe("Customer to quote"),
        title: create.title.describe("Quote title"),
        kind: create.kind.describe(
          "project: priced once; recurring: priced per period",
        ),
        language: create.language.describe(
          "Language the quote is written and printed in",
        ),
        currency: create.currency.describe(
          "ISO 4217 code; defaults to the team's base currency",
        ),
        mode: create.mode.describe(
          "estimate (default): a non-binding estimate; firm: a binding offer",
        ),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    withErrorHandling(
      async (input) =>
        afterWrite(
          ctx,
          await createQuote(db, { ...input, teamId, userId }),
          "Customer not found",
        ),
      "Failed to create quote",
    ),
  );

  server.registerTool(
    "quotes_revise",
    {
      title: "Revise Quote",
      description:
        "Start a new version of a quote: the latest version copied into a new draft, issued today. Refused while the quote already has a draft, and once it is accepted. A quote that has been sent keeps its customer, title, kind and language. Returns the quote as quotes_get does.",
      inputSchema: { quoteId: quoteIdInput },
      annotations: WRITE_ANNOTATIONS,
    },
    withErrorHandling(
      async ({ quoteId }) =>
        afterWrite(ctx, await reviseQuote(db, { teamId, quoteId })),
      "Failed to revise quote",
    ),
  );

  server.registerTool(
    "quotes_mark_sent",
    {
      title: "Mark Quote Sent",
      description:
        "Record that the quote's draft was sent to the client. This sends nothing: quotes go out by hand, as the PDF by email. It freezes the draft with its pricing as of now, stores its PDF, supersedes the version sent before it, and reopens a quote marked lost or no decision. Returns the quote as quotes_get does.",
      inputSchema: {
        quoteId: quoteIdInput,
        sentTo: markQuoteSentSchema.shape.sentTo.describe(
          "Who it was sent to, e.g. an email address",
        ),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    withErrorHandling(async ({ quoteId, sentTo }) => {
      const quote = await load(quoteId);
      if (!quote) return refused("Quote not found");
      const draft = draftVersion(quote.versions);
      if (!draft) {
        return refused(
          "This quote has no draft to send; revise it to start one",
        );
      }

      return afterWrite(
        ctx,
        await markQuoteVersionSent(db, {
          teamId,
          versionId: draft.id,
          sentTo: sentTo || null,
          storePdf: storeQuotePdf(teamId, draft.id),
        }),
      );
    }, "Failed to mark quote sent"),
  );

  server.registerTool(
    "quotes_accept",
    {
      title: "Accept Quote",
      description:
        "Record that the client accepted the version they hold: which scenario, which of its optional lines they took, who said yes, when, and the PO number. The quote is won and a tracker project is opened for it. Calling it again on an accepted quote corrects what was recorded: what the call leaves out stays as recorded, and null clears a name or PO number. Take the scenario and line ids from quotes_get. Attaching the signed order form is done in Midday itself.",
      inputSchema: {
        quoteId: quoteIdInput,
        scenarioId: accept.scenarioId.describe("Scenario accepted"),
        optionalLineIds: accept.optionalLineIds.describe(
          "Optional lines of that scenario the client took too",
        ),
        acceptedAt: accept.acceptedAt.describe(
          "When the client accepted (YYYY-MM-DD); defaults to now",
        ),
        acceptedByName: accept.acceptedByName.describe(
          "Who accepted, on the client's side; null clears it",
        ),
        poNumber: accept.poNumber.describe(
          "The client's purchase order number; null clears it",
        ),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    withErrorHandling(async ({ quoteId, ...answer }) => {
      const quote = await load(quoteId);
      if (!quote) return refused("Quote not found");
      const held = heldVersion(quote.versions);
      if (!held) {
        return refused("This quote has not been sent, so there is no answer");
      }

      return afterWrite(
        ctx,
        await acceptQuoteVersion(db, {
          ...answerToRecord(held, answer),
          teamId,
          versionId: held.id,
          storePdf: storeQuotePdf(teamId, held.id),
        }),
      );
    }, "Failed to accept quote"),
  );

  server.registerTool(
    "quotes_undo_acceptance",
    {
      title: "Undo Quote Acceptance",
      description:
        "Take back a recorded acceptance, for an answer recorded by mistake: the version goes back to sent and the quote to open, and what was recorded (scenario, PO number, who, when) is cleared. The tracker project and the stored PDF stay. Returns the quote as quotes_get does.",
      inputSchema: { quoteId: quoteIdInput },
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    withErrorHandling(async ({ quoteId }) => {
      const quote = await load(quoteId);
      if (!quote) return refused("Quote not found");
      const accepted = acceptedVersion(quote.versions);
      if (!accepted) return refused("This quote has not been accepted");

      return afterWrite(
        ctx,
        await undoQuoteAcceptance(db, { teamId, versionId: accepted.id }),
      );
    }, "Failed to undo quote acceptance"),
  );

  server.registerTool(
    "quotes_set_outcome",
    {
      title: "Set Quote Outcome",
      description:
        "Record that a quote was lost or ended without a decision, with the reason; open takes that back. Won is not set here: use quotes_accept. A won quote keeps its outcome. Returns the quote as quotes_get does.",
      inputSchema: {
        quoteId: quoteIdInput,
        outcome: setQuoteOutcomeSchema.shape.outcome.describe("Outcome"),
        reason: setQuoteOutcomeSchema.shape.reason
          .optional()
          .describe("Why, in a sentence; ignored for open"),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    withErrorHandling(
      async ({ quoteId, outcome, reason }) =>
        afterWrite(
          ctx,
          await setQuoteOutcome(db, {
            teamId,
            quoteId,
            outcome,
            reason: reason ?? null,
          }),
        ),
      "Failed to set quote outcome",
    ),
  );
};

export const registerQuoteTools: RegisterTools = (server, ctx) => {
  if (hasScope(ctx, "invoices.read")) registerReadTools(server, ctx);
  if (hasScope(ctx, "invoices.write")) registerWriteTools(server, ctx);
};
