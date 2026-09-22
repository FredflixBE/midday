"use client";

import {
  type Amount,
  compareScenarios,
  type PricingResult,
  type QuoteContent,
  type QuoteKind,
} from "@midday/quote";
import { Star } from "lucide-react";
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
  const nameOf = (id: string) => {
    const scenario = scenarios.find((s) => s.id === id);
    return scenario ? scenarioName(scenario) : id;
  };

  const money = (value: Amount) => formatQuoteAmount(value, currency, locale);
  const number = (value: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
  /**
   * The difference in words rather than in a sign (FF-1670).
   *
   * It was "−€ 17.612 (−100%)", which needs someone to tell you that minus
   * means the fixed price is the cheaper one — and Frederik asked exactly
   * that: how do I read this. A cell that says "lower" needs no convention
   * and no line of help under the table.
   */
  const against = (cents: number, percent: number | null) => {
    if (cents === 0) return "Same";
    const word = cents > 0 ? "higher" : "lower";
    const amount = money({ amount: Math.abs(cents), max: null });
    return percent === null
      ? `${amount} ${word}`
      : `${amount} ${word} (${number(Math.abs(percent))}%)`;
  };

  // A premium belongs to a pair, not to a scenario: it is what one fixed
  // price asks over one range. Flattened to the pairs that exist, so there
  // is no cell to leave empty (FF-1670).
  const pairs = scenarios.flatMap((s) =>
    byId.get(s.id)!.premiums.map((premium) => ({ fixed: s, premium })),
  );

  const unit = UNIT_LABELS[content.displayUnit];

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <h2 className="text-sm font-medium">Comparison</h2>
        {/* A scenario is a row, not a column (FF-1670). The number of
            scenarios is the unbounded side of this table, and a page grows
            down: at four, a column each squeezed every name to nothing and
            pushed the totals off the edge. Down the page it takes ten
            without changing shape, and a column of totals is what you
            compare anyway — figures line up vertically, not across. */}
        <div className="overflow-x-auto border border-border px-3">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-[#606060]">
                <th className="py-2 pr-4 text-left font-normal">Scenario</th>
                <th className="py-2 pl-4 text-right font-normal">Pricing</th>
                <th className="py-2 pl-4 text-right font-normal">
                  {kind === "recurring" ? `${unit} per year` : unit}
                </th>
                <th className="py-2 pl-4 text-right font-normal">Adjustment</th>
                <th className="py-2 pl-4 text-right font-normal">
                  {kind === "recurring" ? "Per year" : "Total"}
                </th>
                {kind === "recurring" ? (
                  <th className="py-2 pl-4 text-right font-normal">
                    Contract value
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {scenarios.map((s) => {
                const row = byId.get(s.id)!;
                return (
                  <tr
                    key={s.id}
                    className="border-b border-border last:border-0"
                  >
                    <th className="py-2 pr-4 text-left font-normal">
                      <span className="inline-flex items-center gap-1.5">
                        {s.recommended ? (
                          <Star size={12} className="shrink-0 fill-current" />
                        ) : null}
                        {scenarioName(s)}
                      </span>
                    </th>
                    <td className="py-2 pl-4 text-right whitespace-nowrap">
                      {PRICING_LABELS[row.pricing]}
                    </td>
                    <td className="py-2 pl-4 text-right tabular-nums whitespace-nowrap">
                      {formatQuantity(row.hours, content, locale)}
                    </td>
                    <td className="py-2 pl-4 text-right tabular-nums whitespace-nowrap">
                      {row.adjustment === 0
                        ? "–"
                        : formatAdjustment(row.adjustment, locale)}
                    </td>
                    <td className="py-2 pl-4 text-right tabular-nums whitespace-nowrap">
                      {money(row.total)}
                    </td>
                    {kind === "recurring" ? (
                      <td className="py-2 pl-4 text-right tabular-nums whitespace-nowrap">
                        {money(row.contractValue)}
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {pairs.length > 0 ? (
        <section className="space-y-4">
          {/* Not "asks over": that promises a premium, and a fixed price
              under the range is just as common — every figure on OFF-0004
              is. The heading says what the table holds, the cells say which
              way each one goes. */}
          <h2 className="text-sm font-medium">
            Fixed prices against the ranges
          </h2>
          {/* Its own table, because it is its own thing: a premium is a
              relationship between two scenarios, and it only exists where a
              fixed price meets a range. As rows in the table above it left
              half the cells empty and put the range's whole name in every
              label. Here every row is a pair that exists. */}
          <div className="overflow-x-auto border border-border px-3">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-[#606060]">
                  <th className="py-2 pr-4 text-left font-normal">
                    Fixed price
                  </th>
                  <th className="py-2 pl-4 text-left font-normal">Range</th>
                  <th className="py-2 pl-4 text-right font-normal">
                    At the midpoint
                  </th>
                  <th className="py-2 pl-4 text-right font-normal">
                    At the maximum
                  </th>
                </tr>
              </thead>
              <tbody>
                {pairs.map(({ fixed, premium }) => (
                  <tr
                    key={`${fixed.id}-${premium.rangeScenarioId}`}
                    className="border-b border-border last:border-0"
                  >
                    <th className="py-2 pr-4 text-left font-normal">
                      {scenarioName(fixed)}
                    </th>
                    <td className="py-2 pl-4 text-left text-[#606060]">
                      {nameOf(premium.rangeScenarioId)}
                    </td>
                    <td className="py-2 pl-4 text-right tabular-nums whitespace-nowrap">
                      {against(
                        premium.overMidpoint,
                        premium.overMidpointPercent,
                      )}
                    </td>
                    <td className="py-2 pl-4 text-right tabular-nums whitespace-nowrap">
                      {against(premium.overMax, premium.overMaxPercent)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
