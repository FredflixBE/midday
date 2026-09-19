"use client";

import type { RouterOutputs } from "@api/trpc/routers/_app";
import {
  duplicateScenario,
  markRecommended,
  newScenario,
  type PricingResult,
  type QuoteContent,
  type QuoteKind,
  type Recurrence,
  removeScenario,
  type Scenario,
  type ScenarioPricing,
  withPricing,
} from "@midday/quote";
import { Button } from "@midday/ui/button";
import { Checkbox } from "@midday/ui/checkbox";
import { cn } from "@midday/ui/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@midday/ui/dropdown-menu";
import { Input } from "@midday/ui/input";
import { Label } from "@midday/ui/label";
import { Switch } from "@midday/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@midday/ui/tabs";
import { MoreHorizontal, Plus, Star, Trash2 } from "lucide-react";
import { useState } from "react";
import { formatQuoteAmount } from "../quote-pricing";
import type { DraftChange } from "../use-quote-draft";
import { Field, NumberInput } from "./fields";
import { OptionSelect } from "./quote-header-fields";
import { ScenarioLines } from "./scenario-lines";

type WorkType = RouterOutputs["workTypes"]["list"][number];

const PRICING_LABELS = { fixed: "Fixed", range: "Range" };
const PERIOD_LABELS = { month: "Month", quarter: "Quarter", year: "Year" };
const BILLING_LABELS = { in_advance: "In advance", in_arrears: "In arrears" };
const PER_PERIOD = {
  month: "Per month",
  quarter: "Per quarter",
  year: "Per year",
};

const newId = () => crypto.randomUUID();

/**
 * The scenarios of a version, one tab each. A scenario is a complete priced
 * variant the client can pick; Duplicate is how another term, rate or
 * pricing is tried next to the first (R4).
 */
export function QuoteScenarios({
  content,
  kind,
  pricing,
  workTypes,
  currency,
  locale,
  editable,
  change,
}: {
  content: QuoteContent;
  kind: QuoteKind;
  pricing: PricingResult;
  workTypes: WorkType[];
  currency: string;
  locale?: string;
  editable: boolean;
  change: (next: DraftChange) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    content.scenarios.find((s) => s.id === selectedId) ?? content.scenarios[0];

  const setContent = (next: (content: QuoteContent) => QuoteContent) =>
    change((d) => ({ content: next(d.content) }));

  const updateScenario = (id: string, next: (s: Scenario) => Scenario) =>
    setContent((c) => ({
      ...c,
      scenarios: c.scenarios.map((s) => (s.id === id ? next(s) : s)),
    }));

  const add = () => {
    const scenario = newScenario({
      kind,
      name: `Scenario ${content.scenarios.length + 1}`,
      newId,
    });
    setContent((c) => ({ ...c, scenarios: [...c.scenarios, scenario] }));
    setSelectedId(scenario.id);
  };

  const duplicate = (id: string) => {
    const next = duplicateScenario(content, id, newId);
    const index = next.scenarios.findIndex((s) => s.id === id);
    setContent(() => next);
    setSelectedId(next.scenarios[index + 1]?.id ?? null);
  };

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-sm font-medium">Scenarios</h2>
      </div>

      {selected ? (
        <>
          <div className="flex items-center gap-2">
            <Tabs value={selected.id} onValueChange={setSelectedId}>
              <TabsList className="h-auto flex-wrap justify-start">
                {content.scenarios.map((s) => (
                  <TabsTrigger key={s.id} value={s.id} className="gap-1.5">
                    {s.recommended ? (
                      <Star size={12} className="fill-current" />
                    ) : null}
                    {s.name || "Untitled"}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            {editable ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Add scenario"
                onClick={add}
              >
                <Plus size={16} />
              </Button>
            ) : null}
          </div>

          <ScenarioEditor
            key={selected.id}
            scenario={selected}
            pricing={pricing.scenarios.find(
              (p) => p.scenarioId === selected.id,
            )}
            recurring={kind === "recurring"}
            workTypes={workTypes}
            currency={currency}
            locale={locale}
            editable={editable}
            onChange={(next) => updateScenario(selected.id, next)}
            onRecommend={(recommended) =>
              setContent((c) => markRecommended(c, selected.id, recommended))
            }
            onDuplicate={() => duplicate(selected.id)}
            onRemove={() => {
              setContent((c) => removeScenario(c, selected.id));
              setSelectedId(null);
            }}
          />
        </>
      ) : editable ? (
        <Button type="button" variant="outline" onClick={add}>
          Add scenario
        </Button>
      ) : null}
    </section>
  );
}

function ScenarioEditor({
  scenario,
  pricing,
  recurring,
  workTypes,
  currency,
  locale,
  editable,
  onChange,
  onRecommend,
  onDuplicate,
  onRemove,
}: {
  scenario: Scenario;
  pricing: ScenarioPricing | undefined;
  recurring: boolean;
  workTypes: WorkType[];
  currency: string;
  locale?: string;
  editable: boolean;
  onChange: (next: (s: Scenario) => Scenario) => void;
  onRecommend: (recommended: boolean) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const setRecurrence = (patch: Partial<Recurrence>) =>
    onChange((s) =>
      s.recurrence ? { ...s, recurrence: { ...s.recurrence, ...patch } } : s,
    );

  return (
    <div className="space-y-6 border border-border p-4">
      <div className="flex items-end gap-4">
        <Field label="Name" className="flex-1">
          <Input
            aria-label="Scenario name"
            value={scenario.name}
            maxLength={200}
            onChange={(e) => onChange((s) => ({ ...s, name: e.target.value }))}
          />
        </Field>
        <div className="flex h-9 items-center gap-2">
          <Switch
            id={`recommended-${scenario.id}`}
            checked={scenario.recommended}
            onCheckedChange={onRecommend}
          />
          <Label htmlFor={`recommended-${scenario.id}`} className="font-normal">
            Recommended
          </Label>
        </div>
        {editable ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Scenario actions"
              >
                <MoreHorizontal size={16} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onDuplicate}>
                Duplicate scenario
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onRemove} className="text-destructive">
                Delete scenario
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <Field label="Pricing" className="w-[140px]">
          <OptionSelect
            aria-label="Pricing"
            value={scenario.pricing}
            options={PRICING_LABELS}
            onChange={(p) => onChange((s) => withPricing(s, p))}
          />
        </Field>
        {scenario.pricing === "range" ? (
          <CheckboxField
            id={`capped-${scenario.id}`}
            label="Capped"
            checked={scenario.capped}
            onChange={(capped) => onChange((s) => ({ ...s, capped }))}
          />
        ) : null}

        {scenario.recurrence ? (
          <>
            <Field label="Period" className="w-[130px]">
              <OptionSelect
                aria-label="Period"
                value={scenario.recurrence.period}
                options={PERIOD_LABELS}
                onChange={(period) => setRecurrence({ period })}
              />
            </Field>
            <Field label="Term (months)" className="w-[120px]">
              <NumberInput
                aria-label="Term in months"
                integer
                min={1}
                max={1200}
                placeholder="Indefinite"
                value={scenario.recurrence.termMonths}
                onChange={(termMonths) => setRecurrence({ termMonths })}
              />
            </Field>
            <Field label="Billed" className="w-[140px]">
              <OptionSelect
                aria-label="Billed"
                value={scenario.recurrence.billing}
                options={BILLING_LABELS}
                onChange={(billing) => setRecurrence({ billing })}
              />
            </Field>
            <Field label="Notice (months)" className="w-[120px]">
              <NumberInput
                aria-label="Notice in months"
                integer
                max={120}
                placeholder="None"
                value={scenario.recurrence.noticeMonths}
                onChange={(noticeMonths) => setRecurrence({ noticeMonths })}
              />
            </Field>
            <CheckboxField
              id={`renew-${scenario.id}`}
              label="Renews automatically"
              checked={scenario.recurrence.autoRenew}
              onChange={(autoRenew) => setRecurrence({ autoRenew })}
            />
          </>
        ) : null}
      </div>

      <ScenarioLines
        scenario={scenario}
        pricing={pricing}
        recurring={recurring}
        workTypes={workTypes}
        currency={currency}
        locale={locale}
        editable={editable}
        onChange={(lines) => onChange((s) => ({ ...s, lines: lines(s.lines) }))}
      />

      {recurring ? null : (
        <PaymentSchedule
          scenario={scenario}
          pricing={pricing}
          currency={currency}
          locale={locale}
          editable={editable}
          onChange={(rows) =>
            onChange((s) => ({
              ...s,
              paymentSchedule: rows(s.paymentSchedule),
            }))
          }
        />
      )}

      {pricing ? (
        <ScenarioTotals
          pricing={pricing}
          period={scenario.recurrence?.period}
          currency={currency}
          locale={locale}
        />
      ) : null}
    </div>
  );
}

function CheckboxField({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex h-9 items-center gap-2">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(value) => onChange(value === true)}
      />
      <Label htmlFor={id} className="font-normal">
        {label}
      </Label>
    </div>
  );
}

type ScheduleRow = Scenario["paymentSchedule"][number];

function PaymentSchedule({
  scenario,
  pricing,
  currency,
  locale,
  editable,
  onChange,
}: {
  scenario: Scenario;
  pricing: ScenarioPricing | undefined;
  currency: string;
  locale?: string;
  editable: boolean;
  onChange: (rows: (current: ScheduleRow[]) => ScheduleRow[]) => void;
}) {
  const rows = scenario.paymentSchedule;
  const update = (index: number, patch: Partial<ScheduleRow>) =>
    onChange((current) =>
      current.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );

  if (rows.length === 0 && !editable) return null;

  return (
    <div className="space-y-2">
      <div className="text-[12px] text-[#606060]">Payment schedule</div>
      {rows.map((row, index) => (
        // Rows have no id of their own; their order is what they are.
        <div key={index} className="flex items-center gap-3">
          <Input
            aria-label="Payment"
            placeholder="On signing"
            value={row.label}
            maxLength={200}
            className="flex-1"
            onChange={(e) => update(index, { label: e.target.value })}
          />
          <div className="flex w-[100px] items-center gap-1">
            <NumberInput
              aria-label="Percent"
              max={100}
              value={row.percent}
              onChange={(percent) => update(index, { percent: percent ?? 0 })}
            />
            <span className="text-sm text-[#878787]">%</span>
          </div>
          <span className="w-[120px] text-right text-sm tabular-nums">
            {pricing?.paymentSchedule[index]
              ? formatQuoteAmount(
                  { amount: pricing.paymentSchedule[index].amount, max: null },
                  currency,
                  locale,
                )
              : null}
          </span>
          {editable ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Remove payment"
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
              {
                label: "",
                percent: Math.max(
                  0,
                  100 - current.reduce((a, r) => a + r.percent, 0),
                ),
              },
            ])
          }
        >
          Add payment
        </Button>
      ) : null}
    </div>
  );
}

function ScenarioTotals({
  pricing,
  period,
  currency,
  locale,
}: {
  pricing: ScenarioPricing;
  period: Recurrence["period"] | undefined;
  currency: string;
  locale?: string;
}) {
  const totals = pricing.totals;
  const money = (value: { amount: number; max: number | null }) =>
    formatQuoteAmount(value, currency, locale);
  const optional = pricing.optional.reduce((a, l) => a + l.amount, 0);

  // The last money row a person reads as the price is the one in bold.
  type Row = { label: string; value: string; strong?: boolean };
  const rows: Row[] = [];
  if (totals.kind === "project") {
    rows.push({ label: "Hours", value: hours(totals.hours, locale) });
    rows.push({
      label: totals.capped ? "Total (capped)" : "Total",
      value: money(totals.total),
      strong: true,
    });
  } else {
    if (period && period !== "year") {
      rows.push({ label: PER_PERIOD[period], value: money(totals.perPeriod) });
    }
    rows.push({
      label: "Per year",
      value: money(totals.perYear),
      strong: totals.overTerm === null,
    });
    if (totals.overTerm) {
      rows.push({
        label: "Over the term",
        value: money(totals.overTerm),
        strong: true,
      });
    }
    if (totals.oneOff.amount > 0 || (totals.oneOff.max ?? 0) > 0) {
      rows.push({ label: "One-off", value: money(totals.oneOff) });
    }
  }

  return (
    <div className="ml-auto w-full max-w-[320px] space-y-1 text-sm">
      {optional > 0 ? (
        <Total
          label="Optional"
          value={money({ amount: optional, max: null })}
          muted
        />
      ) : null}
      {rows.map((row) => (
        <Total key={row.label} {...row} />
      ))}
    </div>
  );
}

function hours(value: { amount: number; max: number | null }, locale?: string) {
  const n = (h: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(h);
  return value.max === null || value.max === value.amount
    ? n(value.amount)
    : `${n(value.amount)} – ${n(value.max)}`;
}

function Total({
  label,
  value,
  strong,
  muted,
}: {
  label: string;
  value: string;
  strong?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex justify-between gap-4 tabular-nums",
        strong && "border-t border-border pt-2 font-medium",
        muted && "text-[#878787]",
      )}
    >
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
