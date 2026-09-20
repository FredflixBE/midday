/**
 * What an accepted quote is worth as a tracker project (FF-1617). Figures
 * are illustrative: the repository is public. Amounts in cents.
 */
import { describe, expect, test } from "bun:test";
import { quoteBudget } from "./budget";
import type { ItemLine, QuoteContent, Recurrence, Scenario } from "./content";
import { priceVersion } from "./pricing";

const WORK = "p-work";
const RATES = { defaults: { [WORK]: 100 }, customer: {} };

const MONTHLY: Recurrence = {
  period: "month",
  termMonths: 12,
  billing: "in_advance",
  autoRenew: false,
  noticeMonths: null,
};

function item(
  id: string,
  hours: number,
  extra: Partial<ItemLine> = {},
): ItemLine {
  return {
    id,
    type: "item",
    title: `Work ${id}`,
    description: null,
    productId: WORK,
    hours,
    hoursMax: null,
    optional: false,
    once: false,
    ...extra,
  };
}

function budget(scenario: Partial<Scenario>, optionalLineIds: string[] = []) {
  const full: Scenario = {
    id: "s1",
    name: "Scenario",
    recommended: false,
    pricing: "fixed",
    capped: false,
    recurrence: null,
    adjustmentOverride: null,
    paymentSchedule: [],
    lines: [],
    ...scenario,
  };
  const content: QuoteContent = {
    blocks: [],
    rates: { productRates: {}, volumeTiers: [], termTiers: [] },
    displayUnit: "hours",
    hoursPerDay: 8,
    scenarios: [full],
  };
  return quoteBudget(content, priceVersion(content, RATES), {
    scenarioId: "s1",
    optionalLineIds,
  });
}

describe("a project scenario", () => {
  test("is its hours and what they are worth, at a blended rate", () => {
    expect(budget({ lines: [item("a", 10), item("b", 30)] })).toEqual({
      estimate: 40,
      total: 400_000,
      rate: 100,
    });
  });

  test("takes the maximum of a range, which is what was agreed", () => {
    expect(
      budget({
        pricing: "range",
        lines: [item("a", 10, { hoursMax: 16 })],
      }),
    ).toMatchObject({ estimate: 16, total: 160_000 });
  });

  test("rounds part hours up: the estimate is whole hours", () => {
    expect(budget({ lines: [item("a", 10.5)] })?.estimate).toBe(11);
  });

  test("leaves out an optional item nobody took", () => {
    expect(
      budget({ lines: [item("a", 10), item("extra", 5, { optional: true })] }),
    ).toMatchObject({ estimate: 10, total: 100_000 });
  });

  test("counts an optional item that was taken", () => {
    expect(
      budget({ lines: [item("a", 10), item("extra", 5, { optional: true })] }, [
        "extra",
      ]),
    ).toMatchObject({ estimate: 15, total: 150_000 });
  });

  test("blends two rates into the one a tracker project holds", () => {
    const content: QuoteContent = {
      blocks: [],
      rates: {
        productRates: { [WORK]: 100, "p-design": 200 },
        volumeTiers: [],
        termTiers: [],
      },
      displayUnit: "hours",
      hoursPerDay: 8,
      scenarios: [
        {
          id: "s1",
          name: "Scenario",
          recommended: false,
          pricing: "fixed",
          capped: false,
          recurrence: null,
          adjustmentOverride: null,
          paymentSchedule: [],
          lines: [item("a", 10), item("b", 10, { productId: "p-design" })],
        },
      ],
    };

    expect(
      quoteBudget(content, priceVersion(content, RATES), {
        scenarioId: "s1",
        optionalLineIds: [],
      }),
    ).toEqual({ estimate: 20, total: 300_000, rate: 150 });
  });

  test("a scenario the version does not offer has no budget", () => {
    const content: QuoteContent = {
      blocks: [],
      rates: { productRates: {}, volumeTiers: [], termTiers: [] },
      displayUnit: "hours",
      hoursPerDay: 8,
      scenarios: [],
    };
    expect(
      quoteBudget(
        content,
        { scenarios: [] },
        {
          scenarioId: "s1",
          optionalLineIds: [],
        },
      ),
    ).toBeNull();
  });

  test("hours that come to nothing leave the rate open", () => {
    expect(budget({ lines: [] })).toEqual({
      estimate: 0,
      total: 0,
      rate: null,
    });
  });
});

describe("a recurring scenario", () => {
  test("is a year of it: what recurs, times the periods in a year", () => {
    expect(
      budget({ recurrence: MONTHLY, lines: [item("a", 4)] }),
    ).toMatchObject({ estimate: 48, total: 480_000 });
  });

  test("counts a one-off item once, not once a period", () => {
    expect(
      budget({
        recurrence: MONTHLY,
        lines: [item("a", 4), item("setup", 8, { once: true })],
      }),
    ).toMatchObject({ estimate: 56, total: 560_000 });
  });
});
