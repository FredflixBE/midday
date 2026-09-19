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
 * - **Rate of a line:** the quote's own rate for the product, else the
 *   customer's, else the product's default; then the scenario's adjustment.
 *   An adjusted rate is rounded to whole euros; an exact figure is set with
 *   `adjustmentOverride` or a quote rate instead.
 * - **Adjustment:** `adjustmentOverride`, else the highest volume tier met by
 *   the committed hours plus the highest term tier met by the term. Tiers add
 *   up (−5% and −5% is −10%); they do not compound.
 * - **Committed hours:** per year for a recurring scenario, the total for a
 *   fixed one, the minimum for a range. Optional and one-off items commit
 *   nothing. `once` only means one-off on a recurring scenario; on a project
 *   every item is charged once anyway.
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
  productId: string;
  /** To the hundredth. */
  hours: number;
  hoursMax: number | null;
  /** Null when the product has no rate anywhere. */
  rate: number | null;
  amount: number;
  amountMax: number | null;
  optional: boolean;
  /** Charged once on a recurring scenario. Always false on a project. */
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
  /** The maximum is a ceiling. */
  capped: boolean;
};

export type ScenarioPricing = {
  scenarioId: string;
  /** In percent, e.g. −10. */
  adjustment: number;
  committedHours: number;
  /** Per product used in the scenario. */
  rates: Record<string, ResolvedRate>;
  /** Every item, optional ones included. */
  lines: PricedLine[];
  /**
   * Per section, until the next one. Items before the first section form one
   * without a title.
   */
  sections: {
    lineId: string | null;
    title: string | null;
    /** What recurs, per period; or the project's items. */
    amount: Amount;
    /** A recurring scenario's one-off items; zero on a project. */
    oneOff: Amount;
  }[];
  /** Per product, the same split as the sections. */
  products: {
    productId: string;
    hours: Amount;
    amount: Amount;
    oneOffHours: Amount;
    oneOff: Amount;
  }[];
  optional: PricedLine[];
  totals: ProjectTotals | RecurringTotals;
  /** Project scenarios: each row's share of the (maximum) total. */
  paymentSchedule: { label: string; percent: number; amount: number }[];
  issues: PricingIssue[];
};

export type PricingResult = { scenarios: ScenarioPricing[] };

/** Hourly rates in euros, per product id. */
export type ProductRates = {
  defaults: Record<string, number>;
  customer: Record<string, number>;
};

export const PERIODS_PER_YEAR: Record<Recurrence["period"], number> = {
  month: 12,
  quarter: 4,
  year: 1,
};

/** Months that stand in for an indefinite term in the contract value. */
const INDEFINITE_TERM_MONTHS = 48;

const cents = (euros: number) => Math.round(euros * 100);

/**
 * Hours are counted in hundredths, as integers, so 0.2 + 0.7 + 0.1 is 1 and
 * a half cent rounds the way it reads. Finer fractions of an hour round.
 */
const hundredths = (hours: number) => Math.round(hours * 100);

/** Tier percents add up; this keeps −0.1 + −0.2 from reading −0.30000000000000004. */
const cleanPercent = (value: number) => Math.round(value * 1e6) / 1e6;

function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
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
  return cleanPercent(volume + term);
}

function resolveRate(
  productId: string,
  content: QuoteContent,
  rates: ProductRates,
  adjustment: number,
): ResolvedRate | null {
  const candidates: [RateSource, number | undefined][] = [
    ["quote", own(content.rates.productRates, productId)],
    ["customer", own(rates.customer, productId)],
    ["default", own(rates.defaults, productId)],
  ];
  const found = candidates.find(
    (candidate): candidate is [RateSource, number] =>
      candidate[1] !== undefined,
  );
  if (!found) return null;

  const [source, euros] = found;
  const base = cents(euros);
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
  productRates: ProductRates,
): ScenarioPricing {
  const range = scenario.pricing === "range";
  const recurrence = scenario.recurrence;
  const issues: PricingIssue[] = [];
  const rates: Record<string, ResolvedRate> = {};

  const itemLines = scenario.lines.filter(
    (line): line is ItemLine => line.type === "item",
  );
  // `once` means something only where there are periods to be once in.
  const isOneOff = (line: { once: boolean }) =>
    recurrence !== null && line.once;

  // Committed: what recurs, per year, or the project's total; the minimum
  // for a range. Optional and one-off items commit nothing.
  const committedHundredths = itemLines
    .filter((line) => !line.optional && !isOneOff(line))
    .reduce((total, line) => total + hundredths(line.hours), 0);
  const committed =
    (committedHundredths *
      (recurrence ? PERIODS_PER_YEAR[recurrence.period] : 1)) /
    100;
  const adjustment = adjustmentOf(scenario, content.rates, committed);

  const lines: PricedLine[] = itemLines.map((line) => {
    const resolved =
      own(rates, line.productId) ??
      resolveRate(line.productId, content, productRates, adjustment);
    if (resolved) rates[line.productId] = resolved;
    else issues.push({ code: "no_rate", lineId: line.id });

    const rate = resolved?.rate ?? null;
    const hours = hundredths(line.hours);
    const hoursMax = range ? hundredths(line.hoursMax ?? line.hours) : null;
    // Hundredths × cents, both integers, so the only rounding is this one.
    const price = (h: number) => Math.round((h * (rate ?? 0)) / 100);
    return {
      lineId: line.id,
      productId: line.productId,
      hours: hours / 100,
      hoursMax: hoursMax === null ? null : hoursMax / 100,
      rate,
      amount: price(hours),
      amountMax: hoursMax === null ? null : price(hoursMax),
      optional: line.optional,
      once: isOneOff(line),
    };
  });

  const byId = new Map(lines.map((line) => [line.lineId, line]));
  const counted = lines.filter((line) => !line.optional);
  const main = (group: PricedLine[]) => group.filter((l) => !l.once);
  const oneOffs = (group: PricedLine[]) => group.filter((l) => l.once);
  const amounts = (group: PricedLine[]) =>
    sum(
      group.map((l) => ({ amount: l.amount, max: l.amountMax })),
      range,
    );
  const hoursIn = (group: PricedLine[]) => {
    const total = sum(
      group.map((l) => ({
        amount: hundredths(l.hours),
        max: l.hoursMax === null ? null : hundredths(l.hoursMax),
      })),
      range,
    );
    return {
      amount: total.amount / 100,
      max: total.max === null ? null : total.max / 100,
    };
  };

  // Sections, each until the next; what recurs apart from what is once.
  const groups: {
    lineId: string | null;
    title: string | null;
    lines: PricedLine[];
  }[] = [];
  for (const line of scenario.lines) {
    if (line.type === "section") {
      groups.push({ lineId: line.id, title: line.title, lines: [] });
    } else if (line.type === "item") {
      if (groups.length === 0) {
        groups.push({ lineId: null, title: null, lines: [] });
      }
      const priced = byId.get(line.id);
      if (priced && !priced.optional) groups.at(-1)?.lines.push(priced);
    }
  }
  const sections = groups.map((group) => ({
    lineId: group.lineId,
    title: group.title,
    amount: amounts(main(group.lines)),
    oneOff: amounts(oneOffs(group.lines)),
  }));

  // Per product, in the order they first appear.
  const byProduct = new Map<string, PricedLine[]>();
  for (const line of counted) {
    byProduct.set(line.productId, [
      ...(byProduct.get(line.productId) ?? []),
      line,
    ]);
  }
  const products = [...byProduct].map(([productId, group]) => ({
    productId,
    hours: hoursIn(main(group)),
    amount: amounts(main(group)),
    oneOffHours: hoursIn(oneOffs(group)),
    oneOff: amounts(oneOffs(group)),
  }));

  let totals: ProjectTotals | RecurringTotals;
  let paymentSchedule: ScenarioPricing["paymentSchedule"] = [];

  if (recurrence) {
    const perPeriod = amounts(main(counted));
    const oneOff = amounts(oneOffs(counted));
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
      capped: range && scenario.capped,
    };
  } else {
    const total = amounts(counted);
    totals = {
      kind: "project",
      total,
      hours: hoursIn(counted),
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
    products,
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

  const percent = cleanPercent(rows.reduce((a, row) => a + row.percent, 0));
  const complete = percent === 100;
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
  rates: ProductRates,
): PricingResult {
  return {
    scenarios: content.scenarios.map((scenario) =>
      priceScenario(scenario, content, rates),
    ),
  };
}
