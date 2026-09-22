"use client";

import {
  type Amount,
  compareScenarios,
  type PricingResult,
  type QuoteContent,
  type QuoteKind,
} from "@midday/quote";
import { Star } from "lucide-react";
import type { ReactNode } from "react";
import {
  formatAdjustment,
  formatQuantity,
  formatQuoteAmount,
  scenarioName,
} from "../quote-pricing";
import { PRICING_LABELS, UNIT_LABELS } from "./fields";

/**
 * Every scenario side by side (FF-1612, docs/quotes.md §4.7), for the person
 * building the quote and never for the PDF. Where fixed and range scenarios
 * meet, each fixed price shows what it asks over the range's midpoint and
 * maximum: the price of carrying the risk.
 */
export function QuoteComparison({
  content,
  kind,
  pricing,
  currency,
  locale,
}: {
  content: QuoteContent;
  kind: QuoteKind;
  pricing: PricingResult;
  currency: string;
  locale?: string;
}) {
  if (content.scenarios.length < 2) return null;

  const rows = compareScenarios(content, pricing);
  const byId = new Map(rows.map((row) => [row.scenarioId, row]));
  const scenarios = content.scenarios.filter((s) => byId.has(s.id));
  const ranges = scenarios.filter((s) => s.pricing === "range");
  const hasFixed = scenarios.some((s) => s.pricing === "fixed");

  const money = (value: Amount) => formatQuoteAmount(value, currency, locale);
  const number = (value: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
  const signed = (cents: number, percent: number | null) => {
    const sign = cents > 0 ? "+" : cents < 0 ? "−" : "";
    const amount = money({ amount: Math.abs(cents), max: null });
    return percent === null
      ? `${sign}${amount}`
      : `${sign}${amount} (${sign}${number(Math.abs(percent))}%)`;
  };

  // The key is given rather than taken from the label: two ranges both have
  // a "vs midpoint" row, and only the range they belong to tells them apart
  // (FF-1670).
  const row = (key: string, label: string, cell: (id: string) => ReactNode) => (
    <tr key={key} className="border-b border-border last:border-0">
      {/* Fixed while the scenarios scroll past it. Four of them is wider
          than the tab, and a row whose name has scrolled off is a row of
          numbers you cannot read (FF-1670). */}
      <th className="sticky left-0 z-10 bg-background py-2 pr-4 text-left font-normal text-[#606060] whitespace-nowrap">
        {label}
      </th>
      {scenarios.map((s) => (
        <td key={s.id} className="py-2 pl-4 text-right tabular-nums">
          {cell(s.id)}
        </td>
      ))}
    </tr>
  );

  return (
    <section className="space-y-4">
      <h2 className="text-sm font-medium">Comparison</h2>
      <div className="overflow-x-auto border border-border px-3">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="sticky left-0 z-10 bg-background" />
              {scenarios.map((s) => (
                <th
                  key={s.id}
                  className="py-2 pl-4 text-right font-medium whitespace-nowrap"
                >
                  <span className="inline-flex items-center gap-1.5">
                    {s.recommended ? (
                      <Star size={12} className="fill-current" />
                    ) : null}
                    {scenarioName(s)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {row(
              "Pricing",
              "Pricing",
              (id) => PRICING_LABELS[byId.get(id)!.pricing],
            )}
            {row(
              "quantity",
              kind === "recurring"
                ? `${UNIT_LABELS[content.displayUnit]} per year`
                : UNIT_LABELS[content.displayUnit],
              (id) => formatQuantity(byId.get(id)!.hours, content, locale),
            )}
            {row("Adjustment", "Adjustment", (id) => {
              const adjustment = byId.get(id)!.adjustment;
              return adjustment === 0
                ? "–"
                : formatAdjustment(adjustment, locale);
            })}
            {row("total", kind === "recurring" ? "Per year" : "Total", (id) =>
              money(byId.get(id)!.total),
            )}
            {kind === "recurring"
              ? row("Contract value", "Contract value", (id) =>
                  money(byId.get(id)!.contractValue),
                )
              : null}
            {/* A premium is what a fixed price asks over a range, so it
                belongs to that range. Naming the range in every row put 45
                characters in the label column and wrapped it to six lines
                (FF-1670); it is said once, above the two rows it governs. */}
            {hasFixed
              ? ranges.flatMap((range) => {
                  const premium = (id: string) =>
                    byId
                      .get(id)!
                      .premiums.find((p) => p.rangeScenarioId === range.id);
                  return [
                    <tr key={`over-${range.id}`}>
                      {/* The cell spans the table, so pinning it pins
                          nothing — it is already as wide as the scroll. The
                          text inside is what has to stay put. */}
                      <th
                        colSpan={scenarios.length + 1}
                        className="pt-4 pb-1 text-left font-medium"
                      >
                        <span className="sticky left-0 inline-block bg-background whitespace-nowrap">
                          Over {scenarioName(range)}
                        </span>
                      </th>
                    </tr>,
                    row(`${range.id}-midpoint`, "vs midpoint", (id) => {
                      const p = premium(id);
                      return p
                        ? signed(p.overMidpoint, p.overMidpointPercent)
                        : "–";
                    }),
                    row(`${range.id}-maximum`, "vs maximum", (id) => {
                      const p = premium(id);
                      return p ? signed(p.overMax, p.overMaxPercent) : "–";
                    }),
                  ];
                })
              : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
