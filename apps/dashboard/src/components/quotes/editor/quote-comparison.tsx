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
import { formatQuoteAmount } from "../quote-pricing";

const PRICING_LABELS = { fixed: "Fixed", range: "Range" };

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
  const hours = (value: Amount) =>
    value.max === null || value.max === value.amount
      ? number(value.amount)
      : `${number(value.amount)} – ${number(value.max)}`;
  const signed = (cents: number, percent: number | null) => {
    const sign = cents > 0 ? "+" : cents < 0 ? "−" : "";
    const amount = money({ amount: Math.abs(cents), max: null });
    return percent === null
      ? `${sign}${amount}`
      : `${sign}${amount} (${sign}${number(Math.abs(percent))}%)`;
  };

  const row = (label: string, cell: (id: string) => ReactNode) => (
    <tr key={label} className="border-b border-border last:border-0">
      <th className="py-2 pr-4 text-left font-normal text-[#606060]">
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
              <th />
              {scenarios.map((s) => (
                <th
                  key={s.id}
                  className="py-2 pl-4 text-right font-medium whitespace-nowrap"
                >
                  <span className="inline-flex items-center gap-1.5">
                    {s.recommended ? (
                      <Star size={12} className="fill-current" />
                    ) : null}
                    {s.name || "Untitled"}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {row("Pricing", (id) => PRICING_LABELS[byId.get(id)!.pricing])}
            {row(kind === "recurring" ? "Hours per year" : "Hours", (id) =>
              hours(byId.get(id)!.hours),
            )}
            {row("Adjustment", (id) => {
              const adjustment = byId.get(id)!.adjustment;
              return adjustment === 0 ? "–" : `${number(adjustment)}%`;
            })}
            {row(kind === "recurring" ? "Per year" : "Total", (id) =>
              money(byId.get(id)!.total),
            )}
            {kind === "recurring"
              ? row("Contract value", (id) =>
                  money(byId.get(id)!.contractValue),
                )
              : null}
            {hasFixed
              ? ranges.flatMap((range) => {
                  const name = range.name || "Untitled";
                  const premium = (id: string) =>
                    byId
                      .get(id)!
                      .premiums.find((p) => p.rangeScenarioId === range.id);
                  return [
                    row(`Over the midpoint of ${name}`, (id) => {
                      const p = premium(id);
                      return p
                        ? signed(p.overMidpoint, p.overMidpointPercent)
                        : "–";
                    }),
                    row(`Over the maximum of ${name}`, (id) => {
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
