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
import { cn } from "@midday/ui/cn";
import { ComboboxDropdown } from "@midday/ui/combobox-dropdown";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@midday/ui/dropdown-menu";
import { Input } from "@midday/ui/input";
import { Textarea } from "@midday/ui/textarea";
import { MoreHorizontal } from "lucide-react";
import { type CSSProperties, type ReactNode, useContext } from "react";
import { NumberInput, ReadOnlyContext, UNIT_LABELS } from "./fields";
import { SortableList, SortableRow } from "./sortable";

type Product = RouterOutputs["productRates"]["products"][number];

/**
 * Handle, item, product, hours or days, amount, and the row's own menu
 * (FF-1671).
 *
 * Two columns went into that menu. Optional and One-off were a checkbox
 * each, empty on almost every line, and they cost 96px of every row to say
 * nothing — a row says what is true of it and keeps the rest out of sight,
 * the way a block in the document pane does.
 *
 * The amount column is 150px. It was 100, and a range needs 126 to 131, so
 * every amount on every row wrapped onto two lines and the dash dangled at
 * the end of the first. That was the alignment fault, and it was arithmetic
 * rather than taste.
 *
 * Spelled out because Tailwind reads the source for class names and cannot
 * follow one that is pieced together.
 */
const COLUMNS = {
  fixed: "grid-cols-[20px_minmax(160px,1fr)_140px_64px_112px_32px]",
  range:
    "grid-cols-[20px_minmax(160px,1fr)_140px_calc(var(--figure)*2+2.375rem)_112px_32px]",
} as const;

const columns = (range: boolean) => COLUMNS[range ? "range" : "fixed"];

/**
 * A field that is only a field when you are using it (FF-1671).
 *
 * At rest a row reads as the line item it prints as; the box appears under
 * the pointer and while the caret is in it. The editor already works this
 * way — the document pane is the document — and this was the last surface
 * still asking someone to fill in a form about a quote rather than to edit
 * the quote.
 */
const QUIET = "border-transparent hover:border-border focus:border-border";

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

  /**
   * A figure with no currency on it (FF-1671). The symbol was printed
   * twelve times a screen to say something that never changes, so it is
   * said once, in the column heading.
   */
  const figure = (cents: number) => {
    const whole = cents % 100 === 0;
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: whole ? 0 : 2,
    }).format(cents / 100);
  };
  const symbol =
    new Intl.NumberFormat(locale, { style: "currency", currency })
      .formatToParts(0)
      .find((part) => part.type === "currency")?.value ?? currency;

  /**
   * The widest figure the hours column holds, in digits (FF-1671).
   *
   * The two fields used to take half the cell each, so a column sized for
   * three digits drew "8" with two digits of air before the dash. They are
   * `ch` wide instead — with `tabular-nums` a digit is exactly 1ch — and the
   * whole column shares the one width, so the dashes still line up while the
   * control is only as big as what is in it. Two is the floor: a field that
   * fits one digit is not a field you can aim at.
   */
  const figureWidth = Math.max(
    2,
    ...scenario.lines.flatMap((line) =>
      line.type === "item"
        ? [
            String(hoursToUnit(line.hours, unit)).length,
            line.hoursMax === null
              ? 0
              : String(hoursToUnit(line.hoursMax, unit)).length,
          ]
        : [],
    ),
  );

  return (
    <div className="space-y-3">
      {scenario.lines.length > 0 ? (
        // Narrower than the columns can go, the table scrolls rather than
        // squeezing the item out of existence.
        <div
          className="overflow-x-auto border border-border"
          style={
            { "--figure": `calc(${figureWidth}ch + 2px)` } as CSSProperties
          }
        >
          <div
            // `--figure` is in `ch`, which resolves against whatever font the
            // element is set in — so this grid has to be set in the same size
            // as the rows or its hours track comes out narrower. The heading's
            // own size lives on the labels (FF-1671).
            className={`grid ${columns(range)} min-w-[600px] items-center gap-2 border-b border-border px-3 py-2 text-sm text-[#606060]`}
          >
            <span />
            <span className="px-3 text-[12px]">Item</span>
            <span className="px-3 text-[12px]">Product</span>
            {/* A heading sits over the left edge of its own figures, the way
                Item and Product do (FF-1671). A range starts its minimum at
                the left of the cell, so the heading starts there too — past
                the hours control's border and padding, which the figures sit
                inside. A single figure is right-aligned, as one number in a
                column should be, and its heading follows it to that edge. */}
            <span
              className={cn(
                "text-[12px]",
                range ? "pl-[9px]" : "px-3 text-right",
              )}
            >
              {UNIT_LABELS[unit.displayUnit]}
            </span>
            <span className={cn("text-[12px]", !range && "text-right")}>
              Amount ({symbol})
            </span>
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
                      columns={columns(range)}
                      section={line.type === "section"}
                      menu={
                        editable ? (
                          <RowMenu
                            line={line}
                            recurring={recurring}
                            onChange={(patch) => update(line.id, patch)}
                            onRemove={() => remove(line.id)}
                          />
                        ) : null
                      }
                    >
                      {line.type === "section" ? (
                        <>
                          {/* A section is a heading with a subtotal, not an
                              item with its cells left empty (FF-1671). */}
                          <Input
                            aria-label="Section"
                            placeholder="Section"
                            value={line.title}
                            maxLength={500}
                            className={cn(QUIET, "col-span-3 font-medium")}
                            onChange={(e) =>
                              update(line.id, { title: e.target.value })
                            }
                          />
                          <Money
                            range={range}
                            min={sections.get(line.id)?.amount.amount}
                            max={sections.get(line.id)?.amount.max}
                            figure={figure}
                            className="font-medium"
                          />
                        </>
                      ) : line.type === "note" ? (
                        <Input
                          aria-label="Note"
                          placeholder="Note"
                          value={line.text}
                          maxLength={5000}
                          className={cn(QUIET, "col-span-4 italic")}
                          onChange={(e) =>
                            update(line.id, { text: e.target.value })
                          }
                        />
                      ) : (
                        <ItemFields
                          line={line}
                          range={range}
                          unit={unit}
                          products={products}
                          figure={figure}
                          priced={priced.get(line.id)}
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
  columns: grid,
  section,
  menu,
  children,
}: {
  handle: ReactNode;
  /** The same columns the header is drawn on. */
  columns: string;
  /** A section opens a group, so it is given room above it. */
  section?: boolean;
  menu: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "group grid min-w-[600px] items-start gap-2 px-3 py-1 text-sm",
        grid,
        section && "pt-5",
      )}
    >
      <div className="flex h-9 items-center">{handle}</div>
      {children}
      <div className="flex h-9 items-center">{menu}</div>
    </div>
  );
}

/**
 * A figure, or a range aligned on its dash (FF-1671).
 *
 * The dash sits in a column of its own, so every minimum ends where the
 * others end and every maximum starts where the others start. Right-aligning
 * the whole string instead put the dash wherever the number happened to
 * finish, which is why a column of ranges read as a ragged pile.
 *
 * A single figure in a range scenario takes the minimum's place, so it lines
 * up with the minimums rather than floating between the two.
 */
function Money({
  range,
  min,
  max,
  figure,
  className,
}: {
  range: boolean;
  min: number | null | undefined;
  max: number | null | undefined;
  figure: (cents: number) => string;
  className?: string;
}) {
  const body = cn("flex h-9 items-center text-sm tabular-nums", className);
  if (min === null || min === undefined) {
    return <div className={cn(body, "justify-end")} />;
  }
  if (!range) {
    return <div className={cn(body, "justify-end")}>{figure(min)}</div>;
  }
  const spread = max !== null && max !== undefined && max !== min;
  return (
    <div className={cn(body, "grid grid-cols-[1fr_auto_1fr] gap-1")}>
      <span>{figure(min)}</span>
      <span className="text-[#878787]">{spread ? "–" : ""}</span>
      <span>{spread ? figure(max) : ""}</span>
    </div>
  );
}

/**
 * What is true of this line but not worth a column of its own (FF-1671).
 *
 * Optional and One-off were a checkbox each on every row, unticked on nearly
 * all of them, and a description was an empty box under every item —
 * measured on OFF-0004, six of them holding nothing at all, about 43% of the
 * table's height. They live here, and a line shows only what it has.
 */
function RowMenu({
  line,
  recurring,
  onChange,
  onRemove,
}: {
  line: Line;
  recurring: boolean;
  onChange: (patch: Partial<Line>) => void;
  onRemove: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Options for ${rowLabel(line)}`}
          className="h-7 w-7"
        >
          <MoreHorizontal size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {line.type === "item" ? (
          <>
            <DropdownMenuCheckboxItem
              checked={line.optional}
              onCheckedChange={(checked) => onChange({ optional: checked })}
            >
              Optional
            </DropdownMenuCheckboxItem>
            {recurring ? (
              <DropdownMenuCheckboxItem
                checked={line.once}
                onCheckedChange={(checked) => onChange({ once: checked })}
              >
                One-off
              </DropdownMenuCheckboxItem>
            ) : null}
            <DropdownMenuCheckboxItem
              checked={line.description !== null}
              onCheckedChange={(checked) =>
                onChange({ description: checked ? "" : null })
              }
            >
              Description
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem onSelect={onRemove}>Remove</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A flag the row carries, said the way the printed quote says it. */
function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 whitespace-nowrap border border-border px-1 py-0.5 text-[10px] uppercase tracking-wide text-[#878787]">
      {children}
    </span>
  );
}

function ItemFields({
  line,
  range,
  unit,
  products,
  figure,
  priced,
  onChange,
}: {
  line: ItemLine;
  range: boolean;
  unit: UnitSettings;
  products: Product[];
  figure: (cents: number) => string;
  priced:
    | { amount: number; amountMax: number | null; rate: number | null }
    | undefined;
  onChange: (patch: Partial<ItemLine>) => void;
}) {
  const readOnly = useContext(ReadOnlyContext);
  // An inactive product stays pickable only on the line that already has it.
  // Typed in the quote's unit, stored in hours.
  const shown = (hours: number) => hoursToUnit(hours, unit);
  const stored = (value: number | null) => unitToHours(value ?? 0, unit);
  const noun = unit.displayUnit;

  // Priced, but its product has no rate anywhere; a line with no product yet
  // just has no amount.
  const unrated = Boolean(line.productId) && priced?.rate === null;

  const choices = products
    .filter((p) => p.isActive || p.id === line.productId)
    .map((p) => ({ id: p.id, label: p.name }));

  return (
    <>
      <div className="flex min-w-0 flex-col">
        <div className="flex min-w-0 items-center gap-1">
          <Input
            aria-label="Item"
            placeholder="Item"
            value={line.title}
            maxLength={500}
            className={QUIET}
            onChange={(e) => onChange({ title: e.target.value })}
          />
          {/* What the printed line item says about itself. Optional and
              One-off are set from the row's menu now, so without this a
              one-off line would look like every other line (FF-1671). */}
          {line.optional ? <Tag>Optional</Tag> : null}
          {line.once ? <Tag>One-off</Tag> : null}
        </div>
        {/* Only where there is one, or where one has just been asked for
            from the row's menu (FF-1671). */}
        {line.description !== null ? (
          <Textarea
            aria-label="Description"
            placeholder="Description"
            value={line.description}
            maxLength={5000}
            rows={1}
            autoFocus={line.description === ""}
            className={cn(QUIET, "min-h-9 resize-y text-[13px] text-[#606060]")}
            onChange={(e) => onChange({ description: e.target.value })}
          />
        ) : null}
      </div>

      <ComboboxDropdown
        placeholder="Product"
        searchPlaceholder="Search product"
        items={choices}
        selectedItem={choices.find((c) => c.id === line.productId)}
        onSelect={(item) => onChange({ productId: item.id })}
        disabled={readOnly}
        triggerClassName={cn("h-9 text-sm", QUIET)}
      />

      {range ? (
        // One control, not two boxes and a dash between them: a minimum and
        // a maximum are one quantity (FF-1671).
        <div
          className={cn(
            "grid h-9 w-fit grid-cols-[var(--figure)_auto_var(--figure)] items-center gap-1.5 border px-2",
            "border-transparent hover:border-border focus-within:border-border",
          )}
        >
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
            className="border-0 px-0 text-left"
          />
          <span className="text-center text-[#878787]">–</span>
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
            className="border-0 px-0 text-left"
          />
        </div>
      ) : (
        <NumberInput
          aria-label={UNIT_LABELS[unit.displayUnit]}
          value={shown(line.hours)}
          onChange={(value) => onChange({ hours: stored(value) })}
          max={shown(1_000_000)}
          className={QUIET}
        />
      )}

      {unrated ? (
        <div className="flex h-9 items-center justify-end text-sm text-destructive">
          No rate
        </div>
      ) : (
        <Money
          range={range}
          min={priced?.amount}
          max={priced?.amountMax}
          figure={figure}
          className={cn(line.optional && "text-[#878787]")}
        />
      )}
    </>
  );
}
