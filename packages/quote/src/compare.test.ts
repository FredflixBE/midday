/**
 * The internal comparison of a version's scenarios (FF-1612, docs/quotes.md
 * §4.7). Figures are illustrative: the repository is public. Amounts in cents.
 */
import { describe, expect, test } from "bun:test";
import { compareScenarios } from "./compare";
import type { ItemLine, QuoteContent, Scenario } from "./content";
import { priceVersion } from "./pricing";

const WORK = "wt-work";
const RATES = { defaults: { [WORK]: 100 }, customer: {} };

function item(hours: number, hoursMax: number | null = null): ItemLine {
  return {
    id: `l-${hours}-${hoursMax}-${Math.random()}`,
    type: "item",
    title: "Work",
    description: null,
    workTypeId: WORK,
    hours,
    hoursMax,
    optional: false,
    once: false,
  };
}

function scenario(id: string, extra: Partial<Scenario>): Scenario {
  return {
    id,
    name: id,
    recommended: false,
    pricing: "fixed",
    capped: false,
    recurrence: null,
    adjustmentOverride: null,
    paymentSchedule: [],
    lines: [],
    ...extra,
  };
}

function compare(
  scenarios: Scenario[],
  rates: Partial<QuoteContent["rates"]> = {},
) {
  const content: QuoteContent = {
    blocks: [],
    rates: { workTypeRates: {}, volumeTiers: [], termTiers: [], ...rates },
    displayUnit: "hours",
    hoursPerDay: 8,
    scenarios,
  };
  return compareScenarios(content, priceVersion(content, RATES));
}

describe("compareScenarios", () => {
  test("a project scenario compares on its total and hours", () => {
    const [fixed] = compare([
      scenario("fixed", { lines: [item(10), item(5)] }),
    ]);

    expect(fixed).toMatchObject({
      scenarioId: "fixed",
      pricing: "fixed",
      hours: { amount: 15, max: null },
      adjustment: 0,
      total: { amount: 150000, max: null },
      contractValue: { amount: 150000, max: null },
      premiums: [],
    });
  });

  test("a recurring scenario compares on its year and its contract value", () => {
    const [monthly] = compare([
      scenario("monthly", {
        recurrence: {
          period: "month",
          termMonths: 24,
          billing: "in_advance",
          autoRenew: false,
          noticeMonths: null,
        },
        lines: [item(2)],
      }),
    ]);

    expect(monthly).toMatchObject({
      hours: { amount: 24, max: null },
      total: { amount: 240000, max: null },
      contractValue: { amount: 480000, max: null },
    });
  });

  test("a fixed price shows its premium over each range's midpoint and maximum", () => {
    const [fixed, range] = compare([
      scenario("fixed", { lines: [item(120)] }),
      scenario("range", { pricing: "range", lines: [item(80, 120)] }),
    ]);

    // Fixed €12,000; range €8,000–€12,000, so a midpoint of €10,000.
    expect(fixed!.premiums).toEqual([
      {
        rangeScenarioId: "range",
        overMidpoint: 200000,
        overMidpointPercent: 20,
        overMax: 0,
        overMaxPercent: 0,
      },
    ]);
    expect(range!.premiums).toEqual([]);
  });

  test("a fixed price below a range's maximum has a negative premium over it", () => {
    const [fixed] = compare([
      scenario("fixed", { lines: [item(100)] }),
      scenario("range", { pricing: "range", lines: [item(80, 120)] }),
    ]);

    expect(fixed!.premiums[0]).toMatchObject({
      overMidpoint: 0,
      overMax: -200000,
      overMaxPercent: -16.7,
    });
  });

  test("on a recurring quote the premium is per year, whatever the terms", () => {
    const monthly = (termMonths: number) => ({
      period: "month" as const,
      termMonths,
      billing: "in_advance" as const,
      autoRenew: false,
      noticeMonths: null,
    });
    const [fixed] = compare([
      scenario("fixed", { recurrence: monthly(12), lines: [item(10)] }),
      scenario("range", {
        pricing: "range",
        recurrence: monthly(24),
        lines: [item(5, 15)],
      }),
    ]);

    // €12,000 a year against €6,000–€18,000 a year.
    expect(fixed!.premiums[0]).toMatchObject({
      overMidpoint: 0,
      overMax: -600000,
    });
  });

  test("without a range there is no premium to show", () => {
    const rows = compare([
      scenario("a", { lines: [item(10)] }),
      scenario("b", { lines: [item(20)] }),
    ]);

    expect(rows.every((row) => row.premiums.length === 0)).toBe(true);
  });

  test("an empty range has no premium, rather than dividing by zero", () => {
    const [fixed] = compare([
      scenario("fixed", { lines: [item(10)] }),
      scenario("range", { pricing: "range", lines: [] }),
    ]);

    expect(fixed!.premiums[0]).toMatchObject({
      overMidpointPercent: null,
      overMaxPercent: null,
    });
  });

  test("the adjustment is the scenario's, from its tiers", () => {
    const [big] = compare([scenario("big", { lines: [item(200)] })], {
      volumeTiers: [{ minHours: 100, percent: -5 }],
    });

    expect(big!.adjustment).toBe(-5);
    expect(big!.total.amount).toBe(200 * 9500);
  });
});
