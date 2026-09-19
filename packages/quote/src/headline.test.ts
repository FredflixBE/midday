/**
 * The one amount a quote shows in the list (FF-1614). Figures are
 * illustrative: the repository is public. Amounts in cents.
 */
import { describe, expect, test } from "bun:test";
import type { ItemLine, QuoteContent, Recurrence, Scenario } from "./content";
import { quoteHeadline } from "./headline";
import { priceVersion } from "./pricing";

const WORK = "wt-work";
const RATES = { defaults: { [WORK]: 100 }, customer: {} };
const MONTHLY: Recurrence = {
  period: "month",
  termMonths: 12,
  billing: "in_advance",
  autoRenew: false,
  noticeMonths: null,
};

let ids = 0;
function item(hours: number, hoursMax: number | null = null): ItemLine {
  return {
    id: `l-${++ids}`,
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

function scenario(extra: Partial<Scenario>): Scenario {
  return {
    id: `s-${++ids}`,
    name: "Scenario",
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

function headline(scenarios: Scenario[]) {
  const content: QuoteContent = {
    blocks: [],
    rates: { workTypeRates: {}, volumeTiers: [], termTiers: [] },
    displayUnit: "hours",
    hoursPerDay: 8,
    scenarios,
  };
  return quoteHeadline(content, priceVersion(content, RATES));
}

describe("quoteHeadline", () => {
  test("a quote without scenarios has no amount yet", () => {
    expect(headline([])).toBeNull();
  });

  test("one project scenario shows its total", () => {
    expect(headline([scenario({ lines: [item(10)] })])).toEqual({
      amount: { amount: 100000, max: null },
      per: "total",
    });
  });

  test("a range shows its minimum and maximum", () => {
    expect(
      headline([scenario({ pricing: "range", lines: [item(10, 15)] })]),
    ).toEqual({ amount: { amount: 100000, max: 150000 }, per: "total" });
  });

  test("a recurring quote shows its amount per year", () => {
    expect(
      headline([scenario({ recurrence: MONTHLY, lines: [item(2)] })]),
    ).toEqual({ amount: { amount: 240000, max: null }, per: "year" });
  });

  test("the recommended scenario speaks for the quote", () => {
    expect(
      headline([
        scenario({ lines: [item(10)] }),
        scenario({ recommended: true, lines: [item(20)] }),
      ]),
    ).toEqual({ amount: { amount: 200000, max: null }, per: "total" });
  });

  test("without one recommended, the list shows the span of the scenarios", () => {
    expect(
      headline([
        scenario({ lines: [item(20)] }),
        scenario({ pricing: "range", lines: [item(5, 30)] }),
        scenario({ lines: [item(10)] }),
      ]),
    ).toEqual({ amount: { amount: 50000, max: 300000 }, per: "total" });
  });

  test("scenarios that cost the same show one amount", () => {
    expect(
      headline([
        scenario({ lines: [item(10)] }),
        scenario({ lines: [item(10)] }),
      ]),
    ).toEqual({ amount: { amount: 100000, max: null }, per: "total" });
  });
});
