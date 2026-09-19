"use client";

import type { RouterOutputs } from "@api/trpc/routers/_app";
import {
  type ItemLine,
  type Line,
  newLine,
  type Scenario,
  type ScenarioPricing,
} from "@midday/quote";
import { Button } from "@midday/ui/button";
import { Checkbox } from "@midday/ui/checkbox";
import { cn } from "@midday/ui/cn";
import { Input } from "@midday/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@midday/ui/select";
import { Textarea } from "@midday/ui/textarea";
import { Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { formatQuoteAmount } from "../quote-pricing";
import { NumberInput } from "./fields";
import { SortableList, SortableRow } from "./sortable";

type WorkType = RouterOutputs["workTypes"]["list"][number];

/**
 * A scenario's lines: section headings, notes and priced items, in the order
 * they are printed. Each item is hours of one type of work; a range scenario
 * asks for a minimum and a maximum.
 */
export function ScenarioLines({
  scenario,
  pricing,
  recurring,
  workTypes,
  currency,
  locale,
  editable,
  onChange,
}: {
  scenario: Scenario;
  pricing: ScenarioPricing | undefined;
  recurring: boolean;
  workTypes: WorkType[];
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
        // The work type of the item above, else the first one in the list.
        workTypeId:
          lines.filter((l): l is ItemLine => l.type === "item").at(-1)
            ?.workTypeId ?? workTypes.find((w) => !w.archivedAt)?.id,
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
        <div className="border border-border">
          <div className="grid grid-cols-[20px_1fr_180px_140px_repeat(2,56px)_120px_32px] items-center gap-3 border-b border-border px-3 py-2 text-[12px] text-[#606060]">
            <span />
            <span>Item</span>
            <span>Work type</span>
            <span className="text-right">
              {range ? "Hours (min–max)" : "Hours"}
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
                <SortableRow key={line.id} id={line.id} label={label(line)}>
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
                          workTypes={workTypes}
                          amount={amount(
                            priced.get(line.id)?.rate === null
                              ? null
                              : priced.get(line.id)?.amount,
                            priced.get(line.id)?.amountMax,
                          )}
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

function label(line: Line) {
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
    <div className="grid grid-cols-[20px_1fr_180px_140px_repeat(2,56px)_120px_32px] items-start gap-3 px-3 py-2">
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
  workTypes,
  amount,
  onChange,
}: {
  line: ItemLine;
  range: boolean;
  recurring: boolean;
  workTypes: WorkType[];
  amount: string;
  onChange: (patch: Partial<ItemLine>) => void;
}) {
  // Archived types stay pickable only on the line that already has one.
  const choices = workTypes.filter(
    (w) => !w.archivedAt || w.id === line.workTypeId,
  );

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

      <Select
        value={line.workTypeId || undefined}
        onValueChange={(workTypeId) => onChange({ workTypeId })}
      >
        <SelectTrigger aria-label="Work type">
          <SelectValue placeholder="Work type" />
        </SelectTrigger>
        <SelectContent>
          {choices.map((w) => (
            <SelectItem key={w.id} value={w.id}>
              {w.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {range ? (
        <div className="flex items-center gap-1">
          <NumberInput
            aria-label="Minimum hours"
            value={line.hours}
            onChange={(hours) =>
              onChange({
                hours: hours ?? 0,
                // The maximum is never below the minimum.
                hoursMax:
                  line.hoursMax !== null && (hours ?? 0) > line.hoursMax
                    ? (hours ?? 0)
                    : line.hoursMax,
              })
            }
            max={1_000_000}
          />
          <span className="text-[#878787]">–</span>
          <NumberInput
            aria-label="Maximum hours"
            commitOnBlur
            value={line.hoursMax}
            placeholder={String(line.hours)}
            onChange={(hoursMax) =>
              onChange({
                hoursMax:
                  hoursMax === null || hoursMax < line.hours ? null : hoursMax,
              })
            }
            max={1_000_000}
          />
        </div>
      ) : (
        <NumberInput
          aria-label="Hours"
          value={line.hours}
          onChange={(hours) => onChange({ hours: hours ?? 0 })}
          max={1_000_000}
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
        {amount}
      </div>
    </>
  );
}
