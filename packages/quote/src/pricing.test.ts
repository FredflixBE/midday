/**
 * The pricing calculation (FF-1610, docs/quotes.md §4), against the use cases
 * of RES-24 §5. Names are neutral and figures illustrative: the repository is
 * public. Amounts are in cents.
 */
import { describe, expect, test } from "bun:test";
import type {
  ItemLine,
  Line,
  QuoteContent,
  RateSettings,
  Recurrence,
  Scenario,
} from "./content";
import { priceVersion, type ScenarioPricing } from "./pricing";

const MAINTENANCE = "wt-maintenance";
const DEVELOPMENT = "wt-development";
const FOLLOW_UP = "wt-follow-up";

/** Team defaults: €185, €185 and €150 an hour. */
const RATES = {
  defaults: { [MAINTENANCE]: 185, [DEVELOPMENT]: 185, [FOLLOW_UP]: 150 },
  customer: {},
};

let ids = 0;
const id = () => `id-${++ids}`;

function item(
  workTypeId: string,
  hours: number,
  extra: Partial<ItemLine> = {},
): ItemLine {
  return {
    id: id(),
    type: "item",
    title: "Work",
    description: null,
    workTypeId,
    hours,
    hoursMax: null,
    optional: false,
    once: false,
    ...extra,
  };
}

function section(title: string): Line {
  return { id: id(), type: "section", title };
}

function scenario(lines: Line[], extra: Partial<Scenario> = {}): Scenario {
  return {
    id: id(),
    name: "Scenario",
    recommended: false,
    pricing: "fixed",
    capped: false,
    recurrence: null,
    adjustmentOverride: null,
    paymentSchedule: [],
    lines,
    ...extra,
  };
}

const QUARTERLY_YEAR: Recurrence = {
  period: "quarter",
  termMonths: 12,
  billing: "in_advance",
  autoRenew: true,
  noticeMonths: 3,
};

function content(
  scenarios: Scenario[],
  rates: Partial<RateSettings> = {},
): QuoteContent {
  return {
    blocks: [{ id: id(), type: "pricing" }],
    rates: { workTypeRates: {}, volumeTiers: [], termTiers: [], ...rates },
    displayUnit: "days",
    hoursPerDay: 8,
    scenarios,
  };
}

function only(result: ReturnType<typeof priceVersion>): ScenarioPricing {
  expect(result.scenarios).toHaveLength(1);
  return result.scenarios[0]!;
}

describe("the rate of a line", () => {
  test("the work type's default applies when nothing overrides it", () => {
    const s = only(
      priceVersion(content([scenario([item(DEVELOPMENT, 10)])]), RATES),
    );
    expect(s.rates[DEVELOPMENT]).toEqual({
      base: 18500,
      source: "default",
      rate: 18500,
    });
    expect(s.lines[0]).toMatchObject({ rate: 18500, amount: 185000 });
  });

  test("a customer's rate beats the default, and the quote's beats both", () => {
    const rates = {
      ...RATES,
      customer: { [DEVELOPMENT]: 170, [FOLLOW_UP]: 140 },
    };
    const s = only(
      priceVersion(
        content([scenario([item(DEVELOPMENT, 1), item(FOLLOW_UP, 1)])], {
          workTypeRates: { [DEVELOPMENT]: 160.5 },
        }),
        rates,
      ),
    );

    expect(s.rates[DEVELOPMENT]).toMatchObject({
      base: 16050,
      source: "quote",
    });
    expect(s.rates[FOLLOW_UP]).toMatchObject({
      base: 14000,
      source: "customer",
    });
  });

  test("an adjusted rate is rounded to whole euros", () => {
    // €185 − 5% = €175.75 → €176
    const s = only(
      priceVersion(
        content([
          scenario([item(DEVELOPMENT, 10)], { adjustmentOverride: -5 }),
        ]),
        RATES,
      ),
    );
    expect(s.adjustment).toBe(-5);
    expect(s.rates[DEVELOPMENT]?.rate).toBe(17600);
    expect(s.lines[0]?.amount).toBe(176000);
  });

  test("an unadjusted rate keeps its cents", () => {
    const s = only(
      priceVersion(
        content([scenario([item(DEVELOPMENT, 2)])], {
          workTypeRates: { [DEVELOPMENT]: 160.5 },
        }),
        RATES,
      ),
    );
    expect(s.rates[DEVELOPMENT]?.rate).toBe(16050);
    expect(s.lines[0]?.amount).toBe(32100);
  });

  test("a work type with no rate anywhere is reported, and priced at nothing", () => {
    const line = item("wt-unknown", 4);
    const s = only(priceVersion(content([scenario([line])]), RATES));
    expect(s.lines[0]).toMatchObject({ rate: null, amount: 0 });
    expect(s.issues).toEqual([{ code: "no_rate", lineId: line.id }]);
  });
});

describe("the adjustment of a scenario", () => {
  const tiers = {
    volumeTiers: [
      { minHours: 100, percent: -5 },
      { minHours: 200, percent: -10 },
    ],
    termTiers: [{ minMonths: 24, percent: -5 }],
  };

  test("the highest volume tier met by the committed hours applies", () => {
    const [none, some, most] = priceVersion(
      content(
        [
          scenario([item(DEVELOPMENT, 99)]),
          scenario([item(DEVELOPMENT, 150)]),
          scenario([item(DEVELOPMENT, 200)]),
        ],
        tiers,
      ),
      RATES,
    ).scenarios;
    expect([none?.adjustment, some?.adjustment, most?.adjustment]).toEqual([
      0, -5, -10,
    ]);
  });

  test("volume and term tiers add up rather than compound", () => {
    const s = only(
      priceVersion(
        content(
          [
            scenario([item(DEVELOPMENT, 10)], {
              // 10 hours a month is 120 a year: the 100-hour tier.
              recurrence: {
                ...QUARTERLY_YEAR,
                period: "month",
                termMonths: 24,
              },
            }),
          ],
          tiers,
        ),
        RATES,
      ),
    );
    expect(s.committedHours).toBe(120);
    expect(s.adjustment).toBe(-10);
    // €185 × 0.90 = €166.50 → €167
    expect(s.rates[DEVELOPMENT]?.rate).toBe(16700);
  });

  test("a scenario's own adjustment replaces the tiers", () => {
    const s = only(
      priceVersion(
        content(
          [scenario([item(DEVELOPMENT, 500)], { adjustmentOverride: 0 })],
          tiers,
        ),
        RATES,
      ),
    );
    expect(s.adjustment).toBe(0);
    expect(s.rates[DEVELOPMENT]?.rate).toBe(18500);
  });

  test("a range commits its minimum, and optional or one-off hours commit nothing", () => {
    const range = only(
      priceVersion(
        content(
          [
            scenario(
              [
                item(DEVELOPMENT, 90, { hoursMax: 150 }),
                item(DEVELOPMENT, 50, { optional: true }),
              ],
              { pricing: "range" },
            ),
          ],
          tiers,
        ),
        RATES,
      ),
    );
    expect(range.committedHours).toBe(90);
    expect(range.adjustment).toBe(0);

    const recurring = only(
      priceVersion(
        content(
          [
            scenario(
              [item(DEVELOPMENT, 20), item(DEVELOPMENT, 100, { once: true })],
              { recurrence: QUARTERLY_YEAR },
            ),
          ],
          tiers,
        ),
        RATES,
      ),
    );
    expect(recurring.committedHours).toBe(80);
  });

  test("an indefinite term meets no term tier", () => {
    const s = only(
      priceVersion(
        content(
          [
            scenario([item(DEVELOPMENT, 1)], {
              recurrence: { ...QUARTERLY_YEAR, termMonths: null },
            }),
          ],
          tiers,
        ),
        RATES,
      ),
    );
    expect(s.adjustment).toBe(0);
  });
});

describe("use case A: an estimate for a public body", () => {
  // Takeover offered fixed or as a 4–6 day range; support as 8 or 15 days a
  // year, billed per quarter; an optional one-off monitoring setup.
  const takeoverFixed = scenario(
    [
      section("Takeover"),
      item(DEVELOPMENT, 40, { title: "Code and hosting takeover" }),
    ],
    { name: "Takeover, fixed" },
  );
  const takeoverRange = scenario(
    [
      section("Takeover"),
      item(DEVELOPMENT, 32, {
        hoursMax: 48,
        title: "Code and hosting takeover",
      }),
    ],
    { name: "Takeover, range", pricing: "range", capped: true },
  );
  const support = (
    hoursPerQuarter: [number, number, number],
    adjustment: number,
  ) =>
    scenario(
      [
        section("Support"),
        item(MAINTENANCE, hoursPerQuarter[0]),
        item(DEVELOPMENT, hoursPerQuarter[1]),
        item(FOLLOW_UP, hoursPerQuarter[2]),
        section("Optional"),
        item(DEVELOPMENT, 20, {
          optional: true,
          once: true,
          title: "Monitoring setup",
        }),
      ],
      {
        recurrence: { ...QUARTERLY_YEAR, termMonths: null },
        adjustmentOverride: adjustment,
      },
    );

  test("a fixed takeover is its items; a capped range is its minimum and maximum", () => {
    const [fixed, range] = priceVersion(
      content([takeoverFixed, takeoverRange]),
      RATES,
    ).scenarios;

    expect(fixed?.totals).toMatchObject({
      kind: "project",
      total: { amount: 740000, max: null },
      hours: { amount: 40, max: null },
    });
    expect(range?.totals).toMatchObject({
      kind: "project",
      total: { amount: 592000, max: 888000 },
      hours: { amount: 32, max: 48 },
      capped: true,
    });
  });

  test("support is priced per quarter, per year and over 48 months when indefinite", () => {
    // 16 hours a quarter: 8 maintenance, 6 development, 2 follow-up = 64 a year.
    const s = only(priceVersion(content([support([8, 6, 2], 0)]), RATES));

    // 8 × 185 + 6 × 185 + 2 × 150 = 2,890 a quarter
    expect(s.totals).toMatchObject({
      kind: "recurring",
      perPeriod: { amount: 289000, max: null },
      perYear: { amount: 1156000, max: null },
      overTerm: null,
      oneOff: { amount: 0, max: null },
      contractValue: { amount: 4624000, max: null },
    });
  });

  test("the scenario is split by type of work, and the optional item stands apart", () => {
    const s = only(priceVersion(content([support([8, 6, 2], 0)]), RATES));

    expect(s.workTypes).toEqual([
      {
        workTypeId: MAINTENANCE,
        hours: { amount: 8, max: null },
        amount: { amount: 148000, max: null },
      },
      {
        workTypeId: DEVELOPMENT,
        hours: { amount: 6, max: null },
        amount: { amount: 111000, max: null },
      },
      {
        workTypeId: FOLLOW_UP,
        hours: { amount: 2, max: null },
        amount: { amount: 30000, max: null },
      },
    ]);
    expect(s.optional).toEqual([
      expect.objectContaining({ amount: 370000, once: true }),
    ]);
    // The optional item is in no section total either.
    expect(s.sections.map((x) => x.amount.amount)).toEqual([289000, 0]);
  });

  test("the bigger support scenario gets its lower rate from an override", () => {
    // 15 days a year at about €1,400 a day instead of €1,480: −5% on €185.
    const s = only(priceVersion(content([support([15, 10, 5], -5)]), RATES));
    expect(s.rates[DEVELOPMENT]?.rate).toBe(17600);
  });
});

describe("use case B: support by term, with a term tier only", () => {
  test("two years is cheaper per hour than one, and worth more over the term", () => {
    const oneYear = scenario([item(MAINTENANCE, 12)], {
      recurrence: QUARTERLY_YEAR,
    });
    const twoYears = scenario([item(MAINTENANCE, 12)], {
      recurrence: { ...QUARTERLY_YEAR, termMonths: 24 },
    });

    const [a, b] = priceVersion(
      content([oneYear, twoYears], {
        termTiers: [{ minMonths: 24, percent: -5 }],
      }),
      RATES,
    ).scenarios;

    expect(a?.rates[MAINTENANCE]?.rate).toBe(18500);
    expect(b?.rates[MAINTENANCE]?.rate).toBe(17600);
    expect(a?.totals).toMatchObject({
      perYear: { amount: 888000 },
      overTerm: { amount: 888000 },
      contractValue: { amount: 888000 },
    });
    // 12 × 176 × 4 = 8,448 a year, twice.
    expect(b?.totals).toMatchObject({
      perYear: { amount: 844800 },
      overTerm: { amount: 1689600 },
    });
  });
});

describe("use case C: a project in work packages, fixed against a capped range", () => {
  const packages = (range: boolean) => [
    section("Package 1"),
    item(DEVELOPMENT, 40, range ? { hoursMax: 60 } : {}),
    item(FOLLOW_UP, 8, range ? { hoursMax: 12 } : {}),
    section("Package 2"),
    item(DEVELOPMENT, 80, range ? { hoursMax: 120 } : {}),
  ];

  test("section subtotals run until the next section", () => {
    const s = only(priceVersion(content([scenario(packages(false))]), RATES));
    expect(s.sections).toEqual([
      expect.objectContaining({
        title: "Package 1",
        amount: { amount: 860000, max: null },
      }),
      expect.objectContaining({
        title: "Package 2",
        amount: { amount: 1480000, max: null },
      }),
    ]);
    expect(s.totals).toMatchObject({ total: { amount: 2340000, max: null } });
  });

  test("items before the first section get a section without a title", () => {
    const s = only(
      priceVersion(
        content([scenario([item(DEVELOPMENT, 1), ...packages(false)])]),
        RATES,
      ),
    );
    expect(s.sections[0]).toMatchObject({
      lineId: null,
      title: null,
      amount: { amount: 18500, max: null },
    });
  });

  test("milestone payments are shares of the total, and add up to it exactly", () => {
    const s = only(
      priceVersion(
        content([
          scenario(packages(true), {
            pricing: "range",
            capped: true,
            paymentSchedule: [
              { label: "Start", percent: 30 },
              { label: "Package 1 delivered", percent: 30 },
              { label: "Package 2 delivered", percent: 40 },
            ],
          }),
        ]),
        RATES,
      ),
    );

    // Range 23,400 – 35,100; the schedule is of the maximum.
    expect(s.totals).toMatchObject({
      total: { amount: 2340000, max: 3510000 },
    });
    expect(s.paymentSchedule.map((p) => p.amount)).toEqual([
      1053000, 1053000, 1404000,
    ]);
    expect(s.issues).toEqual([]);
  });

  test("rounding lands on the last payment, so the rows sum to the total", () => {
    const s = only(
      priceVersion(
        content([
          scenario([item(DEVELOPMENT, 1)], {
            paymentSchedule: [
              { label: "a", percent: 33.33 },
              { label: "b", percent: 33.33 },
              { label: "c", percent: 33.34 },
            ],
          }),
        ]),
        RATES,
      ),
    );
    const sum = s.paymentSchedule.reduce((a, p) => a + p.amount, 0);
    expect(sum).toBe(18500);
  });

  test("a schedule that does not add up to 100% is reported", () => {
    const s = only(
      priceVersion(
        content([
          scenario([item(DEVELOPMENT, 1)], {
            paymentSchedule: [
              { label: "Start", percent: 50 },
              { label: "End", percent: 40 },
            ],
          }),
        ]),
        RATES,
      ),
    );
    expect(s.issues).toEqual([
      { code: "payment_schedule_not_100", percent: 90 },
    ]);
  });
});

describe("use case D: a small discovery quote", () => {
  test("a short fixed project is priced like any other", () => {
    const s = only(
      priceVersion(
        content([scenario([item(DEVELOPMENT, 12), item(FOLLOW_UP, 4)])]),
        RATES,
      ),
    );
    expect(s.totals).toMatchObject({
      kind: "project",
      total: { amount: 282000, max: null },
    });
  });
});

describe("use case E: one fixed price", () => {
  test("a single line is the whole quote", () => {
    const s = only(
      priceVersion(content([scenario([item(DEVELOPMENT, 16)])]), RATES),
    );
    expect(s.totals).toMatchObject({ total: { amount: 296000, max: null } });
    expect(s.optional).toEqual([]);
    expect(s.issues).toEqual([]);
  });
});

describe("recurring details", () => {
  test("one-off items are added once, next to the recurring amounts", () => {
    const s = only(
      priceVersion(
        content([
          scenario(
            [item(MAINTENANCE, 10), item(DEVELOPMENT, 20, { once: true })],
            {
              recurrence: {
                ...QUARTERLY_YEAR,
                period: "month",
                termMonths: 12,
              },
            },
          ),
        ]),
        RATES,
      ),
    );
    expect(s.totals).toMatchObject({
      perPeriod: { amount: 185000 },
      perYear: { amount: 2220000 },
      overTerm: { amount: 2220000 },
      oneOff: { amount: 370000 },
      contractValue: { amount: 2590000 },
    });
  });

  test("a yearly period is its own year; a range recurs as a minimum and maximum", () => {
    const s = only(
      priceVersion(
        content([
          scenario([item(MAINTENANCE, 10, { hoursMax: 20 })], {
            pricing: "range",
            recurrence: { ...QUARTERLY_YEAR, period: "year", termMonths: 36 },
          }),
        ]),
        RATES,
      ),
    );
    expect(s.totals).toMatchObject({
      perPeriod: { amount: 185000, max: 370000 },
      perYear: { amount: 185000, max: 370000 },
      overTerm: { amount: 555000, max: 1110000 },
    });
  });

  test("the result is plain data that survives being frozen as JSON", () => {
    const result = priceVersion(
      content([
        scenario([item(DEVELOPMENT, 1)], { recurrence: QUARTERLY_YEAR }),
      ]),
      RATES,
    );
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});
