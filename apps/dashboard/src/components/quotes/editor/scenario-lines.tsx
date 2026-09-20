"use client";

import type { RouterOutputs } from "@api/trpc/routers/_app";
import {
  hoursToUnit,
  type ItemLine,
  type Line,
  newLine,
  type Scenario,
  type ScenarioPricing,
  type UnitSettings,
  unitToHours,
} from "@midday/quote";
import { Button } from "@midday/ui/button";
import { Checkbox } from "@midday/ui/checkbox";
import { cn } from "@midday/ui/cn";
import { ComboboxDropdown } from "@midday/ui/combobox-dropdown";
import { Input } from "@midday/ui/input";
import { Textarea } from "@midday/ui/textarea";
import { Trash2 } from "lucide-react";
import { type ReactNode, useContext } from "react";
import { formatQuoteAmount } from "../quote-pricing";
import { NumberInput, ReadOnlyContext, UNIT_LABELS } from "./fields";
import { SortableList, SortableRow } from "./sortable";

type Product = RouterOutputs["productRates"]["products"][number];

/**
 * Handle, item, product, hours or days, optional, one-off, amount, remove.
 * Sized to fit the document's own column (800px, FF-1633) rather than
 * whatever width the page happened to have: the item is what gives, and it
 * is given a floor so it can never collapse to three letters.
 */
const COLUMNS =
  "grid-cols-[20px_minmax(140px,1fr)_140px_120px_repeat(2,48px)_100px_32px]";

/**
 * A scenario's lines: section headings, notes and priced items, in the order
 * they are printed. Each item is hours of one type of work, typed as days on
 * a quote in days; a range scenario asks for a minimum and a maximum.
 */
export function ScenarioLines({
  scenario,
  pricing,
  recurring,
  unit,
  products,
  currency,
  locale,
  editable,
  onChange,
}: {
  scenario: Scenario;
  pricing: ScenarioPricing | undefined;
  recurring: boolean;
  unit: UnitSettings;
  products: Product[];
  currency: string;
  locale?: string;
  editable: boolean;
  onChange: (lines: (current: Line[]) => Line[]) => void;
}) {
  const range = scenario.pricing === "range";
  const priced = new Map(pricing?.lines.map((l) => [l.lineId, l]));
  const sections = new Map(
    pricing?.sections.flatMap((s) => (s.lineId ? [[s.lineId, s]] : [])),
  );

  const update = (id: string, patch: Partial<Line>) =>
    onChange((lines) =>
      lines.map((line) =>
        line.id === id ? ({ ...line, ...patch } as Line) : line,
      ),
    );
  const remove = (id: string) =>
    onChange((lines) => lines.filter((line) => line.id !== id));
  const add = (type: Line["type"]) =>
    onChange((lines) => [
      ...lines,
      newLine(type, {
        newId: () => crypto.randomUUID(),
        // The product of the item above; the first item picks its own.
        productId: lines.filter((l): l is ItemLine => l.type === "item").at(-1)
          ?.productId,
      }),
    ]);

  const amount = (cents: number | null | undefined, max?: number | null) =>
    cents === null || cents === undefined
      ? ""
      : formatQuoteAmount(
          { amount: cents, max: max ?? null },
          currency,
          locale,
        );

  return (
    <div className="space-y-3">
      {scenario.lines.length > 0 ? (
        // Narrower than the columns can go, the table scrolls rather than
        // squeezing the item out of existence.
        <div className="overflow-x-auto border border-border">
          <div
            className={`grid ${COLUMNS} min-w-[680px] items-center gap-2 border-b border-border px-3 py-2 text-[12px] text-[#606060]`}
          >
            <span />
            <span>Item</span>
            <span>Product</span>
            <span className="text-right">
              {UNIT_LABELS[unit.displayUnit]}
              {range ? " (min–max)" : ""}
            </span>
            <span className="text-center">Optional</span>
            <span className="text-center">{recurring ? "One-off" : ""}</span>
            <span className="text-right">Amount</span>
            <span />
          </div>

          <SortableList
            items={scenario.lines}
            disabled={!editable}
            onReorder={(lines) => onChange(() => lines)}
          >
            <div className="divide-y divide-border">
              {scenario.lines.map((line) => (
                <SortableRow key={line.id} id={line.id} label={rowLabel(line)}>
                  {(handle) => (
                    <Row
                      handle={handle}
                      onRemove={editable ? () => remove(line.id) : undefined}
                    >
                      {line.type === "section" ? (
                        <>
                          <Input
                            aria-label="Section"
                            placeholder="Section"
                            value={line.title}
                            maxLength={500}
                            className="col-span-5 font-medium"
                            onChange={(e) =>
                              update(line.id, { title: e.target.value })
                            }
                          />
                          <span className="text-right text-sm font-medium tabular-nums">
                            {amount(
                              sections.get(line.id)?.amount.amount,
                              sections.get(line.id)?.amount.max,
                            )}
                          </span>
                        </>
                      ) : line.type === "note" ? (
                        <Input
                          aria-label="Note"
                          placeholder="Note"
                          value={line.text}
                          maxLength={5000}
                          className="col-span-6 italic"
                          onChange={(e) =>
                            update(line.id, { text: e.target.value })
                          }
                        />
                      ) : (
                        <ItemFields
                          line={line}
                          range={range}
                          recurring={recurring}
                          unit={unit}
                          products={products}
                          amount={
                            // Priced, but its product has no rate anywhere;
                            // a line with no product yet just has no amount.
                            line.productId && priced.get(line.id)?.rate === null
                              ? null
                              : amount(
                                  priced.get(line.id)?.amount,
                                  priced.get(line.id)?.amountMax,
                                )
                          }
                          onChange={(patch) => update(line.id, patch)}
                        />
                      )}
                    </Row>
                  )}
                </SortableRow>
              ))}
            </div>
          </SortableList>
        </div>
      ) : null}

      {editable ? (
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => add("item")}
          >
            Add item
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => add("section")}
          >
            Add section
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => add("note")}
          >
            Add note
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** How a row is named to a screen reader, e.g. "Move Workshop". */
function rowLabel(line: Line) {
  if (line.type === "section") return line.title || "section";
  if (line.type === "note") return "note";
  return line.title || "item";
}

function Row({
  handle,
  onRemove,
  children,
}: {
  handle: ReactNode;
  onRemove?: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className={`grid ${COLUMNS} min-w-[680px] items-start gap-2 px-3 py-2`}
    >
      <div className="flex h-9 items-center">{handle}</div>
      {children}
      <div className="flex h-9 items-center">
        {onRemove ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Remove line"
            onClick={onRemove}
          >
            <Trash2 size={14} />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ItemFields({
  line,
  range,
  recurring,
  unit,
  products,
  amount,
  onChange,
}: {
  line: ItemLine;
  range: boolean;
  recurring: boolean;
  unit: UnitSettings;
  products: Product[];
  /** Null when the product has no rate. */
  amount: string | null;
  onChange: (patch: Partial<ItemLine>) => void;
}) {
  const readOnly = useContext(ReadOnlyContext);
  // An inactive product stays pickable only on the line that already has it.
  // Typed in the quote's unit, stored in hours.
  const shown = (hours: number) => hoursToUnit(hours, unit);
  const stored = (value: number | null) => unitToHours(value ?? 0, unit);
  const noun = unit.displayUnit;

  const choices = products
    .filter((p) => p.isActive || p.id === line.productId)
    .map((p) => ({ id: p.id, label: p.name }));

  return (
    <>
      <div className="flex min-w-0 flex-col gap-1">
        <Input
          aria-label="Item"
          placeholder="Item"
          value={line.title}
          maxLength={500}
          onChange={(e) => onChange({ title: e.target.value })}
        />
        <Textarea
          aria-label="Description"
          placeholder="Description"
          value={line.description ?? ""}
          maxLength={5000}
          rows={1}
          className="min-h-9 resize-y text-[13px] text-[#606060]"
          onChange={(e) => onChange({ description: e.target.value || null })}
        />
      </div>

      <ComboboxDropdown
        placeholder="Product"
        searchPlaceholder="Search product"
        items={choices}
        selectedItem={choices.find((c) => c.id === line.productId)}
        onSelect={(item) => onChange({ productId: item.id })}
        disabled={readOnly}
        triggerClassName="h-9 text-sm"
      />

      {range ? (
        <div className="flex items-center gap-1">
          <NumberInput
            aria-label={`Minimum ${noun}`}
            value={shown(line.hours)}
            onChange={(value) => {
              const hours = stored(value);
              onChange({
                hours,
                // The maximum is never below the minimum.
                hoursMax:
                  line.hoursMax !== null && hours > line.hoursMax
                    ? hours
                    : line.hoursMax,
              });
            }}
            max={shown(1_000_000)}
          />
          <span className="text-[#878787]">–</span>
          <NumberInput
            aria-label={`Maximum ${noun}`}
            commitOnBlur
            min={shown(line.hours)}
            value={line.hoursMax === null ? null : shown(line.hoursMax)}
            placeholder={String(shown(line.hours))}
            onChange={(value) =>
              onChange({ hoursMax: value === null ? null : stored(value) })
            }
            max={shown(1_000_000)}
          />
        </div>
      ) : (
        <NumberInput
          aria-label={UNIT_LABELS[unit.displayUnit]}
          value={shown(line.hours)}
          onChange={(value) => onChange({ hours: stored(value) })}
          max={shown(1_000_000)}
        />
      )}

      <div className="flex h-9 items-center justify-center">
        <Checkbox
          aria-label="Optional"
          checked={line.optional}
          onCheckedChange={(checked) =>
            onChange({ optional: checked === true })
          }
        />
      </div>
      <div className="flex h-9 items-center justify-center">
        {recurring ? (
          <Checkbox
            aria-label="One-off"
            checked={line.once}
            onCheckedChange={(checked) => onChange({ once: checked === true })}
          />
        ) : null}
      </div>

      <div
        className={cn(
          "flex h-9 items-center justify-end text-sm tabular-nums",
          line.optional && "text-[#878787]",
        )}
      >
        {amount ?? <span className="text-destructive">No rate</span>}
      </div>
    </>
  );
}
