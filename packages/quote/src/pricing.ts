import type { ItemLine, QuoteContent, Recurrence, Scenario } from "./content";

/**
 * The pricing calculation (FF-1610, docs/quotes.md §4): one pure function
 * from a version's content and the rates that apply to it, to every total the
 * editor, the PDF and the MCP tools show. What it returns is plain data, so a
 * sent version freezes it as it is (`quote_versions.pricing`).
 *
 * Money is in cents throughout, as integers. Rates come in as euros.
 *
 * The rules, and the decisions taken on them:
 * - **Rate of a line:** the quote's own rate for the work type, else the
 *   customer's, else the work type's default; then the scenario's adjustment.
 *   An adjusted rate is rounded to whole euros; an exact figure is set with
 *   `adjustmentOverride` or a quote rate instead.
 * - **Adjustment:** `adjustmentOverride`, else the highest volume tier met by
 *   the committed hours plus the highest term tier met by the term. Tiers add
 *   up (−5% and −5% is −10%); they do not compound.
 * - **Committed hours:** per year for a recurring scenario, the total for a
 *   fixed one, the minimum for a range. Optional and one-off items commit
 *   nothing.
 * - **Optional items** are priced and left out of every total.
 * - **Recurring:** per period, per year, over the term; one-off items apart.
 *   Contract value is over the term plus one-offs, with 48 months standing in
 *   for an indefinite term (what Belgian procurement counts).
 * - Amounts exclude VAT.
 */

/** A minimum and, for a range, a maximum. `max` is null when fixed. */
export type Amount = { amount: number; max: number | null };

export type RateSource = "quote" | "customer" | "default";

export type ResolvedRate = {
  /** The hourly rate before the adjustment, in cents. */
  base: number;
  source: RateSource;
  /** The hourly rate charged, in cents. */
  rate: number;
};

export type PricedLine = {
  lineId: string;
  workTypeId: string;
  hours: number;
  hoursMax: number | null;
  /** Null when the work type has no rate anywhere. */
  rate: number | null;
  amount: number;
  amountMax: number | null;
  optional: boolean;
  once: boolean;
};

export type PricingIssue =
  | { code: "no_rate"; lineId: string }
  | { code: "payment_schedule_not_100"; percent: number };

export type ProjectTotals = {
  kind: "project";
  total: Amount;
  hours: Amount;
  /** The maximum is a ceiling. */
  capped: boolean;
};

export type RecurringTotals = {
  kind: "recurring";
  perPeriod: Amount;
  perYear: Amount;
  /** Null for an indefinite term. */
  overTerm: Amount | null;
  oneOff: Amount;
  contractValue: Amount;
};

export type ScenarioPricing = {
  scenarioId: string;
  /** In percent, e.g. −10. */
  adjustment: number;
  committedHours: number;
  /** Per work type used in the scenario. */
  rates: Record<string, ResolvedRate>;
  /** Every item, optional ones included. */
  lines: PricedLine[];
  /**
   * Per section, until the next one. Items before the first section form one
   * without a title.
   */
  sections: { lineId: string | null; title: string | null; amount: Amount }[];
  /** Hours and amount per work type, over the items that recur or make up the project. */
  workTypes: { workTypeId: string; hours: Amount; amount: Amount }[];
  optional: PricedLine[];
  totals: ProjectTotals | RecurringTotals;
  /** Project scenarios: each row's share of the (maximum) total. */
  paymentSchedule: { label: string; percent: number; amount: number }[];
  issues: PricingIssue[];
};

export type PricingResult = { scenarios: ScenarioPricing[] };

/** Hourly rates in euros, per work type id. */
export type WorkTypeRates = {
  defaults: Record<string, number>;
  customer: Record<string, number>;
};

const PERIODS_PER_YEAR: Record<Recurrence["period"], number> = {
  month: 12,
  quarter: 4,
  year: 1,
};

/** Months that stand in for an indefinite term in the contract value. */
const INDEFINITE_TERM_MONTHS = 48;

const cents = (euros: number) => Math.round(euros * 100);

function items(scenario: Scenario): ItemLine[] {
  return scenario.lines.filter(
    (line): line is ItemLine => line.type === "item",
  );
}

/** Hours that count towards the volume tiers. */
function committedHours(scenario: Scenario): number {
  const hours = items(scenario)
    .filter((line) => !line.optional && !line.once)
    .reduce((sum, line) => sum + line.hours, 0);
  return scenario.recurrence
    ? hours * PERIODS_PER_YEAR[scenario.recurrence.period]
    : hours;
}

/** The percent of the highest threshold met, or 0. */
function highestTierMet<T>(
  tiers: T[],
  threshold: (tier: T) => number,
  percent: (tier: T) => number,
  value: number | null,
): number {
  if (value === null) return 0;
  let best: T | undefined;
  for (const tier of tiers) {
    if (
      threshold(tier) <= value &&
      (!best || threshold(tier) > threshold(best))
    ) {
      best = tier;
    }
  }
  return best ? percent(best) : 0;
}

function adjustmentOf(
  scenario: Scenario,
  rates: QuoteContent["rates"],
  committed: number,
): number {
  if (scenario.adjustmentOverride !== null) return scenario.adjustmentOverride;

  const volume = highestTierMet(
    rates.volumeTiers,
    (t) => t.minHours,
    (t) => t.percent,
    committed,
  );
  const term = highestTierMet(
    rates.termTiers,
    (t) => t.minMonths,
    (t) => t.percent,
    scenario.recurrence?.termMonths ?? null,
  );
  return volume + term;
}

function resolveRate(
  workTypeId: string,
  content: QuoteContent,
  rates: WorkTypeRates,
  adjustment: number,
): ResolvedRate | null {
  const candidates: [RateSource, number | undefined][] = [
    ["quote", content.rates.workTypeRates[workTypeId]],
    ["customer", rates.customer[workTypeId]],
    ["default", rates.defaults[workTypeId]],
  ];
  const found = candidates.find(([, value]) => value !== undefined);
  if (!found) return null;

  const [source, euros] = found;
  const base = cents(euros!);
  const rate =
    adjustment === 0
      ? base
      : // Whole euros: base × (100 + adjustment) / 100, in cents, to the euro.
        Math.round((base * (100 + adjustment)) / 10_000) * 100;
  return { base, source, rate };
}

function sum(values: Amount[], range: boolean): Amount {
  const amount = values.reduce((a, v) => a + v.amount, 0);
  const max = values.reduce((a, v) => a + (v.max ?? v.amount), 0);
  return { amount, max: range ? max : null };
}

function times(value: Amount, factor: number): Amount {
  return {
    amount: Math.round(value.amount * factor),
    max: value.max === null ? null : Math.round(value.max * factor),
  };
}

function priceScenario(
  scenario: Scenario,
  content: QuoteContent,
  workTypeRates: WorkTypeRates,
): ScenarioPricing {
  const range = scenario.pricing === "range";
  const committed = committedHours(scenario);
  const adjustment = adjustmentOf(scenario, content.rates, committed);
  const issues: PricingIssue[] = [];
  const rates: Record<string, ResolvedRate> = {};

  const lines: PricedLine[] = items(scenario).map((line) => {
    const resolved =
      rates[line.workTypeId] ??
      resolveRate(line.workTypeId, content, workTypeRates, adjustment);
    if (resolved) rates[line.workTypeId] = resolved;
    else issues.push({ code: "no_rate", lineId: line.id });

    const rate = resolved?.rate ?? null;
    const hoursMax = range ? (line.hoursMax ?? line.hours) : null;
    return {
      lineId: line.id,
      workTypeId: line.workTypeId,
      hours: line.hours,
      hoursMax,
      rate,
      amount: Math.round(line.hours * (rate ?? 0)),
      amountMax: hoursMax === null ? null : Math.round(hoursMax * (rate ?? 0)),
      optional: line.optional,
      once: line.once,
    };
  });

  const priced = new Map(lines.map((line) => [line.lineId, line]));
  const counted = lines.filter((line) => !line.optional);
  const amountOf = (line: PricedLine): Amount => ({
    amount: line.amount,
    max: line.amountMax,
  });
  const hoursOf = (line: PricedLine): Amount => ({
    amount: line.hours,
    max: line.hoursMax,
  });

  // Sections, each until the next.
  const sections: ScenarioPricing["sections"] = [];
  let current: {
    lineId: string | null;
    title: string | null;
    lines: PricedLine[];
  } | null = null;
  const close = () => {
    if (current) {
      sections.push({
        lineId: current.lineId,
        title: current.title,
        amount: sum(current.lines.map(amountOf), range),
      });
    }
  };
  for (const line of scenario.lines) {
    if (line.type === "section") {
      close();
      current = { lineId: line.id, title: line.title, lines: [] };
    } else if (line.type === "item") {
      current ??= { lineId: null, title: null, lines: [] };
      const pricedLine = priced.get(line.id)!;
      if (!pricedLine.optional) current.lines.push(pricedLine);
    }
  }
  close();

  // Per work type, over what recurs or makes up the project.
  const byWorkType = new Map<string, PricedLine[]>();
  for (const line of counted.filter((l) => !l.once)) {
    byWorkType.set(line.workTypeId, [
      ...(byWorkType.get(line.workTypeId) ?? []),
      line,
    ]);
  }
  const workTypes = [...byWorkType].map(([workTypeId, group]) => ({
    workTypeId,
    hours: sum(group.map(hoursOf), range),
    amount: sum(group.map(amountOf), range),
  }));

  let totals: ProjectTotals | RecurringTotals;
  let paymentSchedule: ScenarioPricing["paymentSchedule"] = [];

  if (scenario.recurrence) {
    const recurrence = scenario.recurrence;
    const perPeriod = sum(counted.filter((l) => !l.once).map(amountOf), range);
    const oneOff = sum(counted.filter((l) => l.once).map(amountOf), range);
    const perYear = times(perPeriod, PERIODS_PER_YEAR[recurrence.period]);
    const overTerm =
      recurrence.termMonths === null
        ? null
        : times(perYear, recurrence.termMonths / 12);
    const contractTerm =
      overTerm ?? times(perYear, INDEFINITE_TERM_MONTHS / 12);
    totals = {
      kind: "recurring",
      perPeriod,
      perYear,
      overTerm,
      oneOff,
      contractValue: sum([contractTerm, oneOff], range),
    };
  } else {
    const total = sum(counted.map(amountOf), range);
    totals = {
      kind: "project",
      total,
      hours: sum(counted.map(hoursOf), range),
      capped: range && scenario.capped,
    };
    paymentSchedule = schedule(scenario, total.max ?? total.amount, issues);
  }

  return {
    scenarioId: scenario.id,
    adjustment,
    committedHours: committed,
    rates,
    lines,
    sections,
    workTypes,
    optional: lines.filter((line) => line.optional),
    totals,
    paymentSchedule,
    issues,
  };
}

/**
 * Each row's share of the total. The last row takes what rounding left, so
 * the rows always add up to the total exactly.
 */
function schedule(
  scenario: Scenario,
  total: number,
  issues: PricingIssue[],
): ScenarioPricing["paymentSchedule"] {
  const rows = scenario.paymentSchedule;
  if (rows.length === 0) return [];

  const percent = rows.reduce((a, row) => a + row.percent, 0);
  const complete = Math.abs(percent - 100) < 1e-9;
  if (!complete) issues.push({ code: "payment_schedule_not_100", percent });

  let allotted = 0;
  return rows.map((row, index) => {
    const last = complete && index === rows.length - 1;
    const amount = last
      ? total - allotted
      : Math.round((total * row.percent) / 100);
    allotted += amount;
    return { label: row.label, percent: row.percent, amount };
  });
}

export function priceVersion(
  content: QuoteContent,
  rates: WorkTypeRates,
): PricingResult {
  return {
    scenarios: content.scenarios.map((scenario) =>
      priceScenario(scenario, content, rates),
    ),
  };
}
