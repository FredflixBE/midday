"use client";

import type { ComparisonView, ScenarioView } from "@midday/quote/view";
import { cn } from "@midday/ui/cn";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@midday/ui/tabs";
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

  // One scenario is a document that reads straight through: there is no
  // choice to offer and nothing to pick between (FF-1670).
  if (scenarios.length === 1 || !comparison) {
    return (
      <div className="space-y-8 text-sm">
        {scenarios.map((scenario) => (
          <Scenario key={scenario.id} scenario={scenario} />
        ))}
      </div>
    );
  }

  return (
    <Tabs defaultValue={scenarios[0]!.id} className="space-y-8 text-sm">
      <Options comparison={comparison} scenarios={scenarios} />
      {scenarios.map((scenario) => (
        <TabsContent key={scenario.id} value={scenario.id} className="mt-0">
          <Scenario scenario={scenario} />
        </TabsContent>
      ))}
    </Tabs>
  );
}

/**
 * The choice, as the print draws it — and the way to read each option
 * (FF-1670).
 *
 * The panels used to sit above a strip of buttons naming the same four
 * options again, one directly under the other. The panel *is* the option, so
 * it is the control: clicking one opens its line items underneath. That
 * removes an element rather than restyling one.
 *
 * Browser-style tabs on a single line were the alternative and do not
 * survive this content: four of them sharing the measure gives each about
 * 175px, and "Optie 2 · Branding + widgets via de Marketplace" truncates to
 * nothing useful.
 *
 * Two to a row, so a fourth option wraps instead of narrowing the other
 * three. Wrapping is why this is a grid and the print is a row: a page
 * cannot wrap, and a screen has no reason not to.
 *
 * Recommended and selected are said on different channels — a rule above,
 * a tint behind — because an option can be both, or either.
 */
function Options({
  comparison,
  scenarios,
}: {
  comparison: ComparisonView;
  scenarios: ScenarioView[];
}) {
  const lead = comparison.rows.find((row) => row.lead);
  const rest = comparison.rows.filter((row) => !row.lead);

  return (
    <TabsList className="grid h-auto w-full gap-x-5 gap-y-6 bg-transparent p-0 sm:grid-cols-2">
      {comparison.columns.map((column, index) => (
        <TabsTrigger
          key={column.name}
          value={scenarios[index]?.id ?? column.name}
          className={cn(
            "flex h-auto w-full flex-col items-start gap-0 rounded-none px-3 pb-3 pt-2 text-left",
            // Recommended is a rule above; chosen is a rule below, pointing
            // at the line items it opens. Two channels, because an option
            // can be both or either — and a tint alone cannot say which,
            // since hovering one card while another is chosen would show
            // two tinted cards.
            column.recommended
              ? "border-t-2 border-t-primary"
              : "border-t border-t-border",
            "border-b-2 border-b-transparent",
            "data-[state=active]:border-b-primary data-[state=active]:bg-accent data-[state=active]:shadow-none",
            "hover:bg-accent/30",
          )}
        >
          <span className="pb-1 text-[11px] uppercase tracking-wider text-[#606060]">
            {column.recommended ? "Recommended" : "\u00a0"}
          </span>
          <span className="font-medium">{column.name}</span>
          {lead ? (
            <span className="pt-2 text-lg tabular-nums">
              {lead.values[index]}
            </span>
          ) : null}
          <span className="text-[12px] text-[#606060]">
            {rest
              .map((row) =>
                row.unit
                  ? `${row.values[index]} ${row.label.toLowerCase()}`
                  : row.values[index],
              )
              .join(" \u00b7 ")}
          </span>
        </TabsTrigger>
      ))}
    </TabsList>
  );
}

/**
 * Quantity, rate, amount: the columns the PDF sets them in.
 *
 * The amount was 120px and the widest range needed 200 — 22 of 28 figures on
 * OFF-0004 wrapped, breaking after the dash, which is what read as a badly
 * presented range (FF-1675). Without their cents the widest needs 152.
 */
const FIGURES = "grid grid-cols-[minmax(0,1fr)_72px_96px_152px] gap-3";

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
