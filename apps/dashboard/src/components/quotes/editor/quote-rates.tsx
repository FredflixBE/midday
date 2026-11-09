"use client";

import type { RouterOutputs } from "@api/trpc/routers/_app";
import {
  hoursToUnit,
  type QuoteContent,
  type RateSettings,
  unitToHours,
} from "@midday/quote";
import { Button } from "@midday/ui/button";
import { cn } from "@midday/ui/cn";
import { CurrencyInput } from "@midday/ui/currency-input";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { formatHourlyRate, hourlyRateAffixes } from "../hourly-rate";
import type { DraftChange } from "../use-quote-draft";
import { NumberInput } from "./fields";
import { RailSection } from "./quote-rail";

type Product = RouterOutputs["productRates"]["products"][number];
type CustomerRate = RouterOutputs["productRates"]["customerRates"][number];

// Product, then the three rates: the default, the customer's and this
// quote's. Narrow enough for the settings rail (FF-1630).
const RATE_COLUMNS = "grid grid-cols-[minmax(0,1fr)_68px_68px_100px] gap-2";

/**
 * What this quote charges per hour (FF-1612, FF-1620), for each product it
 * uses: the product's price, the customer's own rate, and this quote's, where
 * set. The one that applies is the rightmost, and it is the one drawn in
 * full. Tiers adjust it by volume of hours and by term.
 *
 * Three sections of the settings rail (FF-1630), each collapsing on its own
 * and each disabled on a version that cannot be edited. A section that would
 * open on nothing is not drawn at all: no product is priced until a
 * scenario's lines name one, and a sent version has no tier to add.
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
    <>
      {shown.length > 0 ? (
        <RailSection title="Rates" disabled={!editable}>
          <div>
            <div
              className={cn(
                RATE_COLUMNS,
                "items-center border-b border-border pb-2 text-[11px] text-muted-foreground",
              )}
            >
              <span>Product</span>
              <span className="text-right">Default</span>
              <span className="text-right">Customer</span>
              <span className="text-right">Quote</span>
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
        </RailSection>
      ) : null}

      {content.rates.volumeTiers.length > 0 || editable ? (
        <RailSection
          title="Volume tiers"
          filled={content.rates.volumeTiers.length > 0}
          disabled={!editable}
        >
          <Tiers
            addLabel="Add volume tier"
            threshold={`From ${content.displayUnit}`}
            // Thresholds are hours, typed in the quote's unit like its lines.
            tiers={content.rates.volumeTiers.map((t) => ({
              from: hoursToUnit(t.minHours, content),
              percent: t.percent,
            }))}
            integer={false}
            editable={editable}
            onChange={(next) =>
              setRates((rates) => ({
                ...rates,
                volumeTiers: next(
                  rates.volumeTiers.map((t) => ({
                    from: hoursToUnit(t.minHours, content),
                    percent: t.percent,
                  })),
                ).map((t) => ({
                  minHours: unitToHours(t.from, content),
                  percent: t.percent,
                })),
              }))
            }
          />
        </RailSection>
      ) : null}

      {content.rates.termTiers.length > 0 || editable ? (
        <RailSection
          title="Term tiers"
          filled={content.rates.termTiers.length > 0}
          disabled={!editable}
        >
          <Tiers
            addLabel="Add term tier"
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
        </RailSection>
      ) : null}
    </>
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
        "truncate text-right text-[11px] tabular-nums text-muted-foreground",
        rate !== undefined &&
          (source === applies ? "text-foreground" : "line-through"),
      )}
    >
      {rate === undefined ? "–" : formatHourlyRate(rate, currency)}
    </span>
  );

  return (
    <div className={cn(RATE_COLUMNS, "items-center py-2")}>
      <span className="truncate text-sm" title={product.name}>
        {product.name}
      </span>
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
        className="px-2 text-right"
      />
    </div>
  );
}

type Tier = { from: number; percent: number };

/** Thresholds and their adjustment; the highest one met applies. */
function Tiers({
  addLabel,
  threshold,
  tiers,
  integer,
  editable,
  onChange,
}: {
  addLabel: string;
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
      {tiers.length > 0 ? (
        <>
          <div className="grid grid-cols-[1fr_1fr_32px] gap-2 text-[11px] text-muted-foreground">
            <span>{threshold}</span>
            <span>Adjustment (%)</span>
            <span />
          </div>
          {tiers.map((tier, index) => (
            // Tiers have no id of their own; their order is what they are.
            <div key={index} className="grid grid-cols-[1fr_1fr_32px] gap-2">
              <NumberInput
                aria-label={threshold}
                integer={integer}
                min={integer ? 1 : 0}
                value={tier.from}
                // Emptied, it keeps its threshold until a new one is typed.
                onChange={(from) => {
                  if (from !== null) update(index, { from });
                }}
                className="px-2"
              />
              <NumberInput
                aria-label="Adjustment in percent"
                min={-99.99}
                max={1000}
                value={tier.percent}
                onChange={(percent) => update(index, { percent: percent ?? 0 })}
                className="px-2"
              />
              {editable ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Remove tier"
                  className="h-9 w-8"
                  onClick={() =>
                    onChange((current) => current.filter((_, i) => i !== index))
                  }
                >
                  <Trash2 size={14} />
                </Button>
              ) : null}
            </div>
          ))}
        </>
      ) : null}
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
          {addLabel}
        </Button>
      ) : null}
    </div>
  );
}
