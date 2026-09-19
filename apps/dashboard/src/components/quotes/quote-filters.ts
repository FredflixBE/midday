import { createLoader, parseAsStringLiteral } from "nuqs/server";

/** The quotes list's filters (FF-1614), `?status=` in the address. */
export const QUOTE_FILTERS = {
  all: "All",
  draft: "Draft",
  awaiting: "Awaiting answer",
  expiring: "Expiring",
  expired: "Expired",
  won: "Won",
  lost: "Lost",
} as const;

export type QuoteFilter = keyof typeof QUOTE_FILTERS;

export const quoteFilterParser = parseAsStringLiteral(
  Object.keys(QUOTE_FILTERS) as QuoteFilter[],
).withDefault("all");

export const loadQuoteFilter = createLoader({ status: quoteFilterParser });

/** The list's query for a filter, the same on the server and in the browser. */
export function quotesListInput(filter: QuoteFilter) {
  return filter === "all" ? {} : { status: filter };
}
