import { getPricedQuote, listQuotes } from "@midday/db/queries";
import {
  type Amount,
  hoursToUnit,
  type QuoteContent,
  quoteState,
  type ScenarioPricing,
} from "@midday/quote";
import { z } from "zod";
import { hasScope, READ_ONLY_ANNOTATIONS, type RegisterTools } from "../types";
import { DASHBOARD_URL, withErrorHandling } from "../utils";

/**
 * Quotes for the assistant, read only (FF-1618): the list with the filters
 * of the list page, one quote with every version priced, and what awaits an
 * answer. Amounts are in the quote's currency, excluding VAT; the database
 * keeps cents. Reading quotes goes with reading invoices: the same scope.
 */

type ListRow = Awaited<ReturnType<typeof listQuotes>>[number];
type PricedQuote = NonNullable<Awaited<ReturnType<typeof getPricedQuote>>>;

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
    name: scenario.name,
    recommended: scenario.recommended,
    pricing: scenario.pricing,
    capped: scenario.capped,
    recurrence: scenario.recurrence,
    /** In percent, on every rate; a negative number is a discount. */
    adjustment: priced?.adjustment ?? 0,
    lines: scenario.lines.map((line) => {
      if (line.type !== "item") return line;
      const p = lines.get(line.id);
      return {
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

export function quoteDetail(quote: PricedQuote) {
  const held = quote.versions.find((v) => v.status === "sent") ?? null;
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
    url: quoteUrl(quote.id),
    /** Newest first. */
    versions: quote.versions.map((version) => {
      const priced = new Map(
        version.pricing.scenarios.map((s) => [s.scenarioId, s]),
      );
      return {
        version: version.version,
        status: version.status,
        mode: version.mode,
        issueDate: version.issueDate,
        validUntil: version.validUntil,
        expired: version.expired,
        sentAt: version.sentAt,
        sentTo: version.sentTo,
        displayUnit: version.content.displayUnit,
        hoursPerDay: version.content.hoursPerDay,
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

export const registerQuoteTools: RegisterTools = (server, ctx) => {
  const { db, teamId } = ctx;

  if (!hasScope(ctx, "invoices.read")) {
    return;
  }

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
        "Get one quote with all its versions, newest first. Each version has its status, mode, dates, who it was sent to, and its scenarios with their lines (named by product), rates, totals and payment schedule. A sent version is priced as it was sent; a draft at today's rates. Amounts are in the quote's currency excluding VAT; quantities are hours, and also in the quote's unit (days when it is shown in days).",
      inputSchema: {
        id: z.string().uuid().describe("Quote ID"),
      },
      outputSchema: {
        data: z.record(z.string(), z.any()),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    withErrorHandling(async ({ id }) => {
      const quote = await getPricedQuote(db, { id, teamId, today: todayUtc() });
      if (!quote) {
        return {
          content: [{ type: "text" as const, text: "Quote not found" }],
          isError: true,
        };
      }
      const data = quoteDetail(quote);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
        structuredContent: { data },
      };
    }, "Failed to get quote"),
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
