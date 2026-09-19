import type { QuoteContent } from "./content";
import type { Amount, PricingResult } from "./pricing";

/**
 * The one amount a quote shows in the list (FF-1614): a project's total, or a
 * recurring quote's amount per year. The recommended scenario speaks for the
 * quote; without one, the list shows the span from the cheapest scenario to
 * the dearest.
 */
export type QuoteHeadline = { amount: Amount; per: "total" | "year" };

export function quoteHeadline(
  content: QuoteContent,
  pricing: PricingResult,
): QuoteHeadline | null {
  const recommended = new Set(
    content.scenarios.filter((s) => s.recommended).map((s) => s.id),
  );
  const shown = pricing.scenarios.filter(
    (p) => recommended.size === 0 || recommended.has(p.scenarioId),
  );
  if (shown.length === 0) return null;

  const amounts = shown.map((p) =>
    p.totals.kind === "project" ? p.totals.total : p.totals.perYear,
  );
  const low = Math.min(...amounts.map((a) => a.amount));
  const high = Math.max(...amounts.map((a) => a.max ?? a.amount));

  return {
    amount: { amount: low, max: high === low ? null : high },
    per: shown[0]!.totals.kind === "project" ? "total" : "year",
  };
}
