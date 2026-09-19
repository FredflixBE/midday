"use client";

import type { RouterOutputs } from "@api/trpc/routers/_app";
import type { QuoteContent, RateSettings } from "@midday/quote";
import { Button } from "@midday/ui/button";
import { cn } from "@midday/ui/cn";
import { CurrencyInput } from "@midday/ui/currency-input";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { formatHourlyRate, hourlyRateAffixes } from "../hourly-rate";
import type { DraftChange } from "../use-quote-draft";
import { NumberInput } from "./fields";

type Product = RouterOutputs["productRates"]["products"][number];
type CustomerRate = RouterOutputs["productRates"]["customerRates"][number];

/**
 * What this quote charges per hour (FF-1612, FF-1620), for each product it
 * uses: the product's price, the customer's own rate, and this quote's, where
 * set. The one that applies is the rightmost, and it is the one drawn in
 * full. Tiers adjust it by volume of hours and by term.
 */
export function QuoteRates({
  content,
  products,
  customerRates,
  currency,
  editable,
  change,
}: {
  content: QuoteContent;
  products: Product[];
  /** The quote's, for a product without a currency of its own. */
  currency: string;
  customerRates: CustomerRate[] | undefined;
  editable: boolean;
  change: (next: DraftChange) => void;
}) {
  const setRates = (next: (rates: RateSettings) => RateSettings) =>
    change((d) => ({
      content: { ...d.content, rates: next(d.content.rates) },
    }));

  const customer = new Map(
    (customerRates ?? []).map((r) => [r.productId, r.hourlyRate]),
  );
  const own = content.rates.productRates;
  const used = new Set(
    content.scenarios.flatMap((s) =>
      s.lines.flatMap((l) => (l.type === "item" ? [l.productId] : [])),
    ),
  );
  // Only what this quote prices: a team can have many products.
  const shown = products.filter(
    (p) => used.has(p.id) || Object.hasOwn(own, p.id),
  );

  return (
    <section className="space-y-4">
      <h2 className="text-sm font-medium">Rates</h2>

      {shown.length > 0 ? (
        <div className="border border-border">
          <div className="grid grid-cols-[1fr_120px_120px_160px] items-center gap-3 border-b border-border px-3 py-2 text-[12px] text-[#606060]">
            <span>Product</span>
            <span className="text-right">Default</span>
            <span className="text-right">Customer</span>
            <span className="text-right">This quote</span>
          </div>
          <div className="divide-y divide-border">
            {shown.map((product) => (
              <RateRow
                key={`${product.id}:${own[product.id]}`}
                product={product}
                customerRate={customer.get(product.id)}
                currency={product.currency ?? currency}
                quoteRate={own[product.id]}
                onChange={(rate) =>
                  setRates((rates) => {
                    const { [product.id]: _, ...rest } = rates.productRates;
                    return {
                      ...rates,
                      productRates:
                        rate === undefined
                          ? rest
                          : { ...rest, [product.id]: rate },
                    };
                  })
                }
              />
            ))}
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <Tiers
          title="Volume"
          threshold="From hours"
          tiers={content.rates.volumeTiers.map((t) => ({
            from: t.minHours,
            percent: t.percent,
          }))}
          integer={false}
          editable={editable}
          onChange={(next) =>
            setRates((rates) => ({
              ...rates,
              volumeTiers: next(
                rates.volumeTiers.map((t) => ({
                  from: t.minHours,
                  percent: t.percent,
                })),
              ).map((t) => ({ minHours: t.from, percent: t.percent })),
            }))
          }
        />
        <Tiers
          title="Term"
          threshold="From months"
          tiers={content.rates.termTiers.map((t) => ({
            from: t.minMonths,
            percent: t.percent,
          }))}
          integer
          editable={editable}
          onChange={(next) =>
            setRates((rates) => ({
              ...rates,
              termTiers: next(
                rates.termTiers.map((t) => ({
                  from: t.minMonths,
                  percent: t.percent,
                })),
              ).map((t) => ({ minMonths: t.from, percent: t.percent })),
            }))
          }
        />
      </div>
    </section>
  );
}

function RateRow({
  product,
  customerRate,
  currency,
  quoteRate,
  onChange,
}: {
  product: Product;
  customerRate: number | undefined;
  currency: string;
  quoteRate: number | undefined;
  onChange: (rate: number | undefined) => void;
}) {
  const [value, setValue] = useState(quoteRate);
  const price = product.price ?? undefined;
  const inherited = customerRate ?? price;
  const applies =
    quoteRate !== undefined
      ? "quote"
      : customerRate !== undefined
        ? "customer"
        : "default";

  const cell = (rate: number | undefined, source: typeof applies) => (
    <span
      className={cn(
        "text-right text-sm tabular-nums text-[#878787]",
        rate !== undefined &&
          (source === applies ? "text-primary" : "line-through"),
      )}
    >
      {rate === undefined ? "–" : formatHourlyRate(rate, currency)}
    </span>
  );

  return (
    <div className="grid grid-cols-[1fr_120px_120px_160px] items-center gap-3 px-3 py-2">
      <span className="truncate text-sm">{product.name}</span>
      {cell(price, "default")}
      {cell(customerRate, "customer")}
      <CurrencyInput
        aria-label={`${product.name} rate for this quote`}
        value={value ?? ""}
        placeholder={
          inherited === undefined
            ? undefined
            : formatHourlyRate(inherited, currency)
        }
        onValueChange={(values) => setValue(values.floatValue)}
        onBlur={() => {
          if (value !== quoteRate) onChange(value);
        }}
        decimalScale={2}
        allowNegative={false}
        {...hourlyRateAffixes(currency)}
        className="text-right"
      />
    </div>
  );
}

type Tier = { from: number; percent: number };

/** Thresholds and their adjustment; the highest one met applies. */
function Tiers({
  title,
  threshold,
  tiers,
  integer,
  editable,
  onChange,
}: {
  title: string;
  threshold: string;
  tiers: Tier[];
  integer: boolean;
  editable: boolean;
  onChange: (next: (tiers: Tier[]) => Tier[]) => void;
}) {
  const update = (index: number, patch: Partial<Tier>) =>
    onChange((current) =>
      current.map((t, i) => (i === index ? { ...t, ...patch } : t)),
    );

  return (
    <div className="space-y-2">
      <div className="text-sm">{title}</div>
      <div className="grid grid-cols-[1fr_1fr_36px] gap-3 text-[12px] text-[#606060]">
        <span>{threshold}</span>
        <span>Adjustment (%)</span>
        <span />
      </div>
      {tiers.map((tier, index) => (
        // Tiers have no id of their own; their order is what they are.
        <div key={index} className="grid grid-cols-[1fr_1fr_36px] gap-3">
          <NumberInput
            aria-label={threshold}
            integer={integer}
            min={integer ? 1 : 0}
            value={tier.from}
            // Emptied, it keeps its threshold until a new one is typed.
            onChange={(from) => {
              if (from !== null) update(index, { from });
            }}
          />
          <NumberInput
            aria-label="Adjustment in percent"
            min={-99.99}
            max={1000}
            value={tier.percent}
            onChange={(percent) => update(index, { percent: percent ?? 0 })}
          />
          {editable ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Remove tier"
              onClick={() =>
                onChange((current) => current.filter((_, i) => i !== index))
              }
            >
              <Trash2 size={14} />
            </Button>
          ) : null}
        </div>
      ))}
      {editable ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            onChange((current) => [
              ...current,
              { from: integer ? 12 : 100, percent: -5 },
            ])
          }
        >
          Add {title.toLowerCase()} tier
        </Button>
      ) : null}
    </div>
  );
}
