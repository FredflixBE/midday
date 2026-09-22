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

  return (
    <div className="space-y-8 text-sm">
      {comparison ? <Options comparison={comparison} /> : null}
      {/* One scenario is a document that reads straight through; several are
          alternatives, and a reader looks at one at a time (FF-1670). Four
          stacked line-item tables is not a document pane, it is a scroll. */}
      {scenarios.length === 1 ? (
        <Scenario scenario={scenarios[0]!} />
      ) : (
        <Tabs defaultValue={scenarios[0]!.id}>
          <TabsList className="mb-4 flex h-auto flex-wrap justify-start gap-1 bg-transparent p-0">
            {scenarios.map((scenario) => (
              <TabsTrigger
                key={scenario.id}
                value={scenario.id}
                className="gap-1.5 border border-border data-[state=active]:bg-accent"
              >
                {scenario.recommended ? (
                  <Star size={12} className="fill-current" />
                ) : null}
                {scenario.name}
              </TabsTrigger>
            ))}
          </TabsList>
          {scenarios.map((scenario) => (
            <TabsContent key={scenario.id} value={scenario.id}>
              <Scenario scenario={scenario} />
            </TabsContent>
          ))}
        </Tabs>
      )}
    </div>
  );
}

/**
 * The choice, as the print draws it (FF-1670).
 *
 * This used to be a table with a column per scenario, which held together at
 * two and squeezed at three — and it had stopped showing what it previews:
 * FF-1666 made the PDF draw a panel per option with the total set large, and
 * this was still drawing the old table.
 *
 * Two to a row, so a fourth scenario wraps instead of narrowing the other
 * three. Wrapping is why this is a grid and the print is a row: a page
 * cannot wrap, and a screen has no reason not to.
 */
function Options({ comparison }: { comparison: ComparisonView }) {
  const lead = comparison.rows.find((row) => row.lead);
  const rest = comparison.rows.filter((row) => !row.lead);

  return (
    <div className="grid gap-x-5 gap-y-6 sm:grid-cols-2">
      {comparison.columns.map((column, index) => (
        <div
          key={column.name}
          className={cn(
            "pt-2",
            // One signal, not three: the recommended option is the one with
            // weight on it, the same as in print.
            column.recommended
              ? "border-t-2 border-primary"
              : "border-t border-border",
          )}
        >
          <div className="pb-1 text-[11px] uppercase tracking-wider text-[#606060]">
            {column.recommended ? "Recommended" : "\u00a0"}
          </div>
          <div className="font-medium">{column.name}</div>
          {lead ? (
            <div className="pt-2 text-lg tabular-nums">
              {lead.values[index]}
            </div>
          ) : null}
          <div className="text-[12px] text-[#606060]">
            {rest
              .map((row) =>
                row.unit
                  ? `${row.values[index]} ${row.label.toLowerCase()}`
                  : row.values[index],
              )
              .join(" \u00b7 ")}
          </div>
        </div>
      ))}
    </div>
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
