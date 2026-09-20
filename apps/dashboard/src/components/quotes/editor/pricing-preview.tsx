"use client";

import type { ComparisonView, ScenarioView } from "@midday/quote/view";
import { cn } from "@midday/ui/cn";
import { Star } from "lucide-react";

/**
 * What the pricing prints, on screen (FF-1640). Every word and number here
 * was worked out by `pricingView`, the same function the PDF is laid out
 * from, so there is nothing to keep in step: this only decides where it
 * goes. It is read-only — the Pricing tab is where the numbers are changed.
 */
export function PricingPreview({
  comparison,
  scenarios,
}: {
  comparison: ComparisonView | null;
  scenarios: ScenarioView[];
}) {
  if (scenarios.length === 0) return null;

  return (
    <div className="space-y-8 text-sm">
      {comparison ? <Comparison comparison={comparison} /> : null}
      {scenarios.map((scenario) => (
        <Scenario key={scenario.id} scenario={scenario} />
      ))}
    </div>
  );
}

function Comparison({ comparison }: { comparison: ComparisonView }) {
  return (
    <table className="w-full">
      <thead>
        <tr className="border-b border-border">
          <th />
          {comparison.columns.map((column) => (
            <th
              key={column.name}
              className="py-2 pl-4 text-right font-medium align-bottom"
            >
              <span className="inline-flex items-center gap-1.5">
                {column.recommended ? (
                  <Star size={12} className="fill-current" />
                ) : null}
                {column.name}
              </span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {comparison.rows.map((row) => (
          <tr key={row.label} className="border-b border-border last:border-0">
            <th className="py-2 pr-4 text-left font-normal text-[#606060]">
              {row.label}
            </th>
            {row.values.map((value, index) => (
              <td
                // A column is a scenario, and its name is what names it.
                key={comparison.columns[index]?.name ?? index}
                className="py-2 pl-4 text-right tabular-nums"
              >
                {value}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Quantity, rate, amount: the columns the PDF sets them in.
const FIGURES = "grid grid-cols-[minmax(0,1fr)_72px_96px_120px] gap-3";

function Scenario({ scenario }: { scenario: ScenarioView }) {
  return (
    <section className="space-y-1">
      <div className="flex items-center gap-1.5 pb-1 font-medium">
        {scenario.recommended ? (
          <Star size={12} className="fill-current" />
        ) : null}
        {scenario.name}
      </div>
      {scenario.conditions ? (
        <p className="pb-1 text-[#606060]">{scenario.conditions}</p>
      ) : null}

      <div
        className={cn(
          FIGURES,
          "border-b border-border pb-1 text-[12px] text-[#606060]",
        )}
      >
        <span />
        <span className="text-right">{scenario.quantityLabel}</span>
        <span />
        <span className="text-right">{scenario.amountLabel}</span>
      </div>

      {scenario.rows.map((row, index) => {
        // Rows are a printed sequence, not records: two identical notes are
        // two notes, and only their order tells them apart.
        const key = `${row.type}-${index}`;
        if (row.type === "section") {
          return (
            <div key={key} className="pt-3 font-medium">
              {row.title}
            </div>
          );
        }
        if (row.type === "note") {
          return (
            <p key={key} className="text-[12px] italic text-[#606060]">
              {row.text}
            </p>
          );
        }
        if (row.type === "subtotal") {
          return (
            <div
              key={key}
              className={cn(FIGURES, "border-t border-border pt-1")}
            >
              <span className="text-[#606060]">{row.label}</span>
              <span />
              <span />
              <span className="text-right tabular-nums">{row.amount}</span>
            </div>
          );
        }
        return (
          <div key={key} className={cn(FIGURES, "py-0.5")}>
            <div className="min-w-0">
              <div>{row.title}</div>
              {row.description ? (
                <div className="text-[12px] text-[#606060]">
                  {row.description}
                </div>
              ) : null}
            </div>
            <span className="text-right tabular-nums">{row.quantity}</span>
            <span className="text-right tabular-nums text-[#606060]">
              {row.rate}
            </span>
            <span className="text-right tabular-nums">{row.amount}</span>
          </div>
        );
      })}

      {scenario.products.length > 0 ? (
        <div className="space-y-0.5 pt-2">
          {scenario.products.map((product) => (
            <div key={product.name} className={cn(FIGURES, "text-[#606060]")}>
              <span className="truncate">{product.name}</span>
              <span className="text-right tabular-nums">
                {product.quantity}
              </span>
              <span className="text-right tabular-nums">{product.rate}</span>
              <span className="text-right tabular-nums">{product.amount}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="space-y-0.5 pt-2">
        {scenario.totals.map((total) => (
          <div
            key={total.label}
            className={cn(
              FIGURES,
              total.strong && "border-t border-border pt-1 font-medium",
            )}
          >
            <span>{total.label}</span>
            <span />
            <span />
            <span className="text-right tabular-nums">{total.value}</span>
          </div>
        ))}
      </div>
      {scenario.cappedNote ? (
        <p className="text-right text-[12px] text-[#606060]">
          {scenario.cappedNote}
        </p>
      ) : null}

      {scenario.optional.length > 0 ? (
        <div className="space-y-0.5 pt-3">
          {scenario.optional.map((item, index) => (
            <div key={`${item.title}-${index}`} className={cn(FIGURES)}>
              <span className="min-w-0 truncate">{item.title}</span>
              <span className="text-right tabular-nums">{item.quantity}</span>
              <span />
              <span className="text-right tabular-nums">{item.amount}</span>
            </div>
          ))}
        </div>
      ) : null}

      {scenario.paymentSchedule.length > 0 ? (
        <div className="space-y-0.5 pt-3">
          {scenario.paymentSchedule.map((row, index) => (
            <div key={`${row.label}-${index}`} className={cn(FIGURES)}>
              <span className="min-w-0 truncate">{row.label}</span>
              <span className="text-right tabular-nums">{row.percent}</span>
              <span />
              <span className="text-right tabular-nums">{row.amount}</span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
