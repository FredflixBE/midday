"use client";

import type { RouterOutputs } from "@api/trpc/routers/_app";
import {
  duplicateScenario,
  markRecommended,
  newScenario,
  type PricingIssue,
  type QuoteContent,
  type QuoteKind,
  type Recurrence,
  removeScenario,
  type Scenario,
  type ScenarioPricing,
  type UnitSettings,
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
import { formatUnitRate } from "../hourly-rate";
import {
  formatAdjustment,
  formatQuantity,
  formatQuantityWithUnit,
  formatQuoteAmount,
  scenarioName,
} from "../quote-pricing";
import type { DraftChange } from "../use-quote-draft";
import {
  Field,
  NumberInput,
  OptionSelect,
  PRICING_LABELS,
  UNIT_LABELS,
} from "./fields";
import { ScenarioLines } from "./scenario-lines";

type Product = RouterOutputs["productRates"]["products"][number];

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
  products,
  currency,
  locale,
  editable,
  change,
  selected,
  pricing,
  onSelect,
}: {
  content: QuoteContent;
  kind: QuoteKind;
  products: Product[];
  currency: string;
  locale?: string;
  editable: boolean;
  change: (next: DraftChange) => void;
  /** The scenario on show, chosen by the page so the rail can price it. */
  selected: Scenario | undefined;
  /** What `selected` comes to, worked out once by the page. */
  pricing: ScenarioPricing | undefined;
  onSelect: (id: string | null) => void;
}) {
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
    onSelect(scenario.id);
  };

  const duplicate = (id: string) => {
    // The copy takes the first id asked for, so it can be selected.
    const copyId = newId();
    const ids = [copyId];
    setContent((c) => duplicateScenario(c, id, () => ids.shift() ?? newId()));
    onSelect(copyId);
  };

  return (
    <section className="space-y-4">
      {/* No heading: the tab it is on is called Pricing (FF-1639). */}
      {selected ? (
        <>
          <div className="flex items-center gap-2">
            <Tabs value={selected.id} onValueChange={onSelect}>
              <TabsList className="h-auto flex-wrap justify-start">
                {content.scenarios.map((s) => (
                  <TabsTrigger key={s.id} value={s.id} className="gap-1.5">
                    {s.recommended ? (
                      <Star size={12} className="fill-current" />
                    ) : null}
                    {scenarioName(s)}
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
            pricing={pricing}
            recurring={kind === "recurring"}
            unit={content}
            products={products}
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
              onSelect(null);
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
  unit,
  products,
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
  unit: UnitSettings;
  products: Product[];
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
    <fieldset
      disabled={!editable}
      className="min-w-0 space-y-6 border border-border p-4"
    >
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
        <Field label="Adjustment (%)" className="w-[120px]">
          <NumberInput
            aria-label="Adjustment in percent"
            min={-99.99}
            max={1000}
            // Empty: the tiers decide, and what they decide shows here.
            placeholder={String(pricing?.adjustment ?? 0)}
            value={scenario.adjustmentOverride}
            onChange={(adjustmentOverride) =>
              onChange((s) => ({ ...s, adjustmentOverride }))
            }
          />
        </Field>

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
        unit={unit}
        products={products}
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

      {/* Under xl the rail sits below the whole document, too far from the
          lines to be any use, so the totals stay here instead (FF-1632). */}
      {pricing ? (
        <div className="xl:hidden">
          <ScenarioTotals
            pricing={pricing}
            unit={unit}
            products={products}
            period={scenario.recurrence?.period}
            currency={currency}
            locale={locale}
          />
        </div>
      ) : null}
    </fieldset>
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

  const incomplete = pricing?.issues.find(
    (
      issue,
    ): issue is Extract<PricingIssue, { code: "payment_schedule_not_100" }> =>
      issue.code === "payment_schedule_not_100",
  );

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
      {incomplete ? (
        <div className="flex items-center gap-3">
          <span className="flex-1" />
          <span className="w-[100px] pr-5 text-right text-sm text-destructive tabular-nums">
            {incomplete.percent}%
          </span>
          <span className="w-[120px]" />
          {editable ? <span className="w-9" /> : null}
        </div>
      ) : null}
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

/**
 * What the scenario on show comes to (FF-1632). It lives in the settings
 * rail, where it stays on screen while the lines that move it are changed —
 * a draft's are worked out live by `priceVersion`, a sent version's read from
 * the pricing frozen when it went. The contract value is not here: it is
 * internal, and belongs to the comparison panel.
 */
export function ScenarioTotals({
  pricing,
  unit,
  products,
  period,
  currency,
  locale,
}: {
  pricing: ScenarioPricing;
  unit: UnitSettings;
  products: Product[];
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
  // Per type of work, with the rate it is charged at (use cases A and B).
  const names = new Map(products.map((w) => [w.id, w.name]));
  const rate = (productId: string) => {
    const cents = pricing.rates[productId]?.rate;
    return cents === undefined
      ? ""
      : ` × ${formatUnitRate(cents / 100, currency, unit)}`;
  };
  if (totals.kind === "project") {
    rows.push({
      label: UNIT_LABELS[unit.displayUnit],
      value: formatQuantity(totals.hours, unit, locale),
    });
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
    <div className="space-y-1 text-sm">
      {pricing.adjustment !== 0 ? (
        <Total
          label="Adjustment"
          value={formatAdjustment(pricing.adjustment, locale)}
          muted
        />
      ) : null}
      {/* A line whose product has not been picked yet has no name to break
          down under, and reading "Unknown" told nobody anything. Its hours
          still count towards the scenario's own total, which is right: they
          are quoted, they are just not priced. */}
      {pricing.products.flatMap((w) => {
        const name = names.get(w.productId);
        return name
          ? [
              <Total
                key={w.productId}
                label={`${name} · ${formatQuantityWithUnit(w.hours, unit, locale)}${rate(w.productId)}`}
                value={money(w.amount)}
                muted
              />,
            ]
          : [];
      })}
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
