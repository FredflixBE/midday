import type { QuoteContent, Scenario } from "./content";
import { type Amount, PERIODS_PER_YEAR, type PricingResult } from "./pricing";

/**
 * The internal comparison panel (FF-1612, docs/quotes.md §4.7): every
 * scenario of a version side by side, and what a fixed price costs the client
 * over a range — the price of carrying the risk (RES-24 §3). It is never
 * printed.
 */

export type ScenarioPremium = {
  rangeScenarioId: string;
  /** The fixed price minus the range's midpoint, in cents. */
  overMidpoint: number;
  /** Of the midpoint, to one decimal; null when the range is empty. */
  overMidpointPercent: number | null;
  /** The fixed price minus the range's maximum, in cents. */
  overMax: number;
  overMaxPercent: number | null;
};

export type ScenarioComparison = {
  scenarioId: string;
  pricing: Scenario["pricing"];
  /** A project's hours; a recurring scenario's hours per year. */
  hours: Amount;
  adjustment: number;
  /** A project's total; a recurring scenario's amount per year. */
  total: Amount;
  /** What the contract is worth: a project's total, a recurrence over its term plus one-offs. */
  contractValue: Amount;
  /** A fixed scenario's premium over each range scenario; empty otherwise. */
  premiums: ScenarioPremium[];
};

const percentOf = (part: number, whole: number) =>
  whole === 0 ? null : Math.round((part / whole) * 1000) / 10;

export function compareScenarios(
  content: QuoteContent,
  pricing: PricingResult,
): ScenarioComparison[] {
  const rows = content.scenarios.flatMap((scenario) => {
    const priced = pricing.scenarios.find((p) => p.scenarioId === scenario.id);
    if (!priced) return [];
    const totals = priced.totals;

    let hours: Amount;
    if (totals.kind === "project") {
      hours = totals.hours;
    } else {
      const periods = scenario.recurrence
        ? PERIODS_PER_YEAR[scenario.recurrence.period]
        : 1;
      // What recurs, per period, across the work types, then over a year.
      const perPeriod = priced.workTypes.reduce(
        (sum, w) => ({
          amount: sum.amount + w.hours.amount,
          max: w.hours.max === null ? sum.max : (sum.max ?? 0) + w.hours.max,
        }),
        { amount: 0, max: null as number | null },
      );
      const year = (h: number) => Math.round(h * periods * 100) / 100;
      hours = {
        amount: year(perPeriod.amount),
        max: perPeriod.max === null ? null : year(perPeriod.max),
      };
    }

    return [
      {
        scenarioId: scenario.id,
        pricing: scenario.pricing,
        hours,
        adjustment: priced.adjustment,
        total: totals.kind === "project" ? totals.total : totals.perYear,
        contractValue:
          totals.kind === "project" ? totals.total : totals.contractValue,
        premiums: [] as ScenarioPremium[],
      },
    ];
  });

  const ranges = rows.filter((row) => row.pricing === "range");
  for (const row of rows) {
    if (row.pricing !== "fixed") continue;
    row.premiums = ranges.map((range) => {
      const max = range.contractValue.max ?? range.contractValue.amount;
      const midpoint = Math.round((range.contractValue.amount + max) / 2);
      const fixed = row.contractValue.amount;
      return {
        rangeScenarioId: range.scenarioId,
        overMidpoint: fixed - midpoint,
        overMidpointPercent: percentOf(fixed - midpoint, midpoint),
        overMax: fixed - max,
        overMaxPercent: percentOf(fixed - max, max),
      };
    });
  }

  return rows;
}
