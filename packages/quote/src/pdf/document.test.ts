/**
 * What a quote PDF says (FF-1613), for use cases A and C of RES-24 §5. Names
 * are neutral and figures illustrative: the repository is public.
 */
import { describe, expect, test } from "bun:test";
import type {
  ItemLine,
  Line,
  QuoteContent,
  Recurrence,
  Scenario,
} from "../content";
import { priceVersion } from "../pricing";
import {
  type QuotePdfInput,
  quoteDocument,
  type ScenarioRow,
} from "./document";

const DEVELOPMENT = "p-development";
const MAINTENANCE = "p-maintenance";
const RATES = {
  defaults: { [DEVELOPMENT]: 185, [MAINTENANCE]: 150 },
  customer: {},
};
const NAMES = { [DEVELOPMENT]: "Development", [MAINTENANCE]: "Maintenance" };

let ids = 0;
const id = () => `id-${++ids}`;

function item(
  productId: string,
  hours: number,
  extra: Partial<ItemLine> = {},
): ItemLine {
  return {
    id: id(),
    type: "item",
    title: "Work",
    description: null,
    productId,
    hours,
    hoursMax: null,
    optional: false,
    once: false,
    ...extra,
  };
}

const section = (title: string): Line => ({ id: id(), type: "section", title });

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

const paragraph = (text: string) => ({
  type: "doc" as const,
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

function content(
  scenarios: Scenario[],
  extra: Partial<QuoteContent> = {},
): QuoteContent {
  return {
    blocks: [
      { id: id(), type: "text", heading: "Context", body: paragraph("Why") },
      { id: id(), type: "pricing" },
      { id: id(), type: "text", heading: "Terms", body: paragraph("How") },
    ],
    rates: { productRates: {}, volumeTiers: [], termTiers: [] },
    displayUnit: "hours",
    hoursPerDay: 8,
    scenarios,
    ...extra,
  };
}

function input(
  c: QuoteContent,
  extra: Partial<QuotePdfInput> = {},
): QuotePdfInput {
  return {
    quoteNumber: "OFF-0007",
    title: "Website",
    kind: c.scenarios[0]?.recurrence ? "recurring" : "project",
    language: "en",
    currency: "EUR",
    version: 1,
    mode: "estimate",
    issueDate: "2026-09-19",
    validUntil: "2026-10-19",
    fromDetails: paragraph("Sender BV"),
    customerDetails: paragraph("Customer NV"),
    content: c,
    pricing: priceVersion(c, RATES),
    productNames: NAMES,
    customerCountryCode: "BE",
    teamCountryCode: "BE",
    ...extra,
  };
}

/** Intl separates symbol and number with a no-break space; compare on content. */
const plain = (value: unknown) =>
  JSON.parse(JSON.stringify(value).replace(/[\u00a0\u202f]/g, " "));

const pricingBlock = (doc: ReturnType<typeof quoteDocument>) => {
  const block = doc.blocks.find((b) => b.type === "pricing");
  if (block?.type !== "pricing") throw new Error("No pricing block");
  return block;
};

const items = (rows: ScenarioRow[]) =>
  rows.filter(
    (r): r is Extract<ScenarioRow, { type: "item" }> => r.type === "item",
  );

describe("the header", () => {
  test("names the quote with its version, and its dates in its language", () => {
    const c = content([scenario([item(DEVELOPMENT, 8)])]);
    const doc = quoteDocument(
      input(c, { version: 2, language: "nl", mode: "firm" }),
    );

    expect(doc.number).toBe("OFF-0007 v2");
    expect(doc.meta).toEqual([
      { label: "Datum", value: "19 september 2026" },
      { label: "Geldig tot", value: "19 oktober 2026" },
    ]);
    expect(doc.statement).toBe("Dit aanbod is bindend tot 19 oktober 2026.");
  });

  test("an estimate says it is not binding", () => {
    const doc = quoteDocument(
      input(content([scenario([item(DEVELOPMENT, 8)])])),
    );
    expect(doc.number).toBe("OFF-0007");
    expect(doc.statement).toBe("Indicative estimate, not a binding offer.");
  });

  test("keeps the sender and customer as snapshotted", () => {
    const doc = quoteDocument(input(content([])));
    expect(doc.fromDetails).toEqual(paragraph("Sender BV"));
    expect(doc.customerDetails).toEqual(paragraph("Customer NV"));
    expect(
      quoteDocument(input(content([]), { fromDetails: null })).fromDetails,
    ).toBeNull();
  });
});

describe("the blocks", () => {
  test("keep their order, with the scenarios where the pricing block is", () => {
    const doc = quoteDocument(
      input(content([scenario([item(DEVELOPMENT, 8)])])),
    );
    expect(
      doc.blocks.map((b) => (b.type === "text" ? b.heading : "pricing")),
    ).toEqual(["Context", "pricing", "Terms"]);
  });
});

describe("use case A: support in days, two scenarios, an optional one-off", () => {
  const quarterly: Recurrence = {
    period: "quarter",
    termMonths: 24,
    billing: "in_advance",
    autoRenew: true,
    noticeMonths: 3,
  };
  const support = (days: [number, number], extra: Partial<Scenario> = {}) =>
    scenario(
      [
        section("Support"),
        item(MAINTENANCE, days[0] * 8, { title: "First-line support" }),
        item(DEVELOPMENT, days[1] * 8, { title: "Development" }),
        item(DEVELOPMENT, 16, {
          title: "Monitoring setup",
          optional: true,
          once: true,
        }),
      ],
      { recurrence: quarterly, ...extra },
    );
  const small = support([1, 1], { name: "8 days a year" });
  const large = support([2, 2], { name: "16 days a year", recommended: true });
  const doc = plain(
    quoteDocument(
      input(content([small, large], { displayUnit: "days", hoursPerDay: 8 })),
    ),
  ) as ReturnType<typeof quoteDocument>;
  const block = pricingBlock(doc);

  test("lines read in days, at a day rate", () => {
    const [first] = block.scenarios;
    expect(first!.quantityLabel).toBe("Days");
    expect(first!.amountLabel).toBe("Per quarter");
    expect(items(first!.rows)[0]).toMatchObject({
      title: "First-line support",
      quantity: "1",
      rate: "€1,200.00/day",
      amount: "€1,200.00",
    });
  });

  test("the optional item stands apart with its price, out of the lines", () => {
    const [first] = block.scenarios;
    expect(items(first!.rows).map((r) => r.title)).toEqual([
      "First-line support",
      "Development",
    ]);
    expect(first!.optional).toEqual([
      {
        title: "Monitoring setup",
        description: null,
        quantity: "2",
        amount: "+€2,960.00",
        oneOff: true,
      },
    ]);
  });

  test("is split by type of work, in days", () => {
    expect(block.scenarios[0]!.products).toEqual([
      {
        name: "Maintenance",
        quantity: "1",
        rate: "€1,200.00/day",
        amount: "€1,200.00",
      },
      {
        name: "Development",
        quantity: "1",
        rate: "€1,480.00/day",
        amount: "€1,480.00",
      },
    ]);
  });

  test("totals per quarter, per year and over the term, and no contract value", () => {
    expect(block.scenarios[0]!.totals).toEqual([
      { label: "Per quarter", value: "€2,680.00", strong: false },
      { label: "Per year", value: "€10,720.00", strong: false },
      { label: "Over the term", value: "€21,440.00", strong: true },
    ]);
  });

  test("states the term, billing, renewal and notice", () => {
    expect(block.scenarios[0]!.conditions).toBe(
      "Term of 24 months, billed in advance, renews automatically, 3 months' notice.",
    );
  });

  test("a single section has no subtotal", () => {
    expect(block.scenarios[0]!.rows.some((r) => r.type === "subtotal")).toBe(
      false,
    );
  });

  test("compares the scenarios, the recommended one marked", () => {
    expect(block.comparison).toEqual({
      columns: [
        { name: "8 days a year", recommended: false },
        { name: "16 days a year", recommended: true },
      ],
      rows: [
        { label: "Pricing", values: ["Fixed price", "Fixed price"] },
        { label: "Days per year", values: ["8", "16"] },
        { label: "Per year", values: ["€10,720.00", "€21,440.00"] },
        { label: "Over the term", values: ["€21,440.00", "€42,880.00"] },
      ],
    });
  });
});

describe("use case C: work packages, fixed against a capped range", () => {
  const packages = (range: boolean) => [
    section("Package 1"),
    item(DEVELOPMENT, 40, range ? { hoursMax: 60 } : {}),
    item(MAINTENANCE, 8, range ? { hoursMax: 12 } : {}),
    { id: id(), type: "note" as const, text: "Includes a review" },
    section("Package 2"),
    item(DEVELOPMENT, 80, range ? { hoursMax: 120 } : {}),
  ];
  const fixed = scenario(packages(false), {
    name: "Fixed",
    paymentSchedule: [
      { label: "Start", percent: 30 },
      { label: "Delivery", percent: 70 },
    ],
  });
  const capped = scenario(packages(true), {
    name: "Range",
    pricing: "range",
    capped: true,
  });
  const doc = plain(
    quoteDocument(input(content([fixed, capped]))),
  ) as ReturnType<typeof quoteDocument>;
  const [f, r] = pricingBlock(doc).scenarios;

  test("each section closes with its subtotal, notes in place", () => {
    expect(
      f!.rows.map((row) =>
        row.type === "item"
          ? `${row.quantity} h ${row.amount}`
          : row.type === "subtotal"
            ? `= ${row.amount}`
            : row.type === "section"
              ? `# ${row.title}`
              : `> ${row.text}`,
      ),
    ).toEqual([
      "# Package 1",
      "40 h €7,400.00",
      "8 h €1,200.00",
      "> Includes a review",
      "= €8,600.00",
      "# Package 2",
      "80 h €14,800.00",
      "= €14,800.00",
    ]);
    expect(items(f!.rows)[0]!.rate).toBe("€185.00/h");
  });

  test("a range reads minimum to maximum, with the ceiling said", () => {
    expect(items(r!.rows)[0]).toMatchObject({
      quantity: "40 – 60",
      amount: "€7,400.00 – €11,100.00",
    });
    expect(r!.totals).toEqual([
      { label: "Total", value: "€23,400.00 – €35,100.00", strong: true },
    ]);
    expect(r!.cappedNote).toBe(
      "The maximum is a ceiling and will not be exceeded.",
    );
    expect(f!.cappedNote).toBeNull();
  });

  test("the payment schedule is in amounts and shares", () => {
    expect(f!.paymentSchedule).toEqual([
      { label: "Start", percent: "30%", amount: "€7,020.00" },
      { label: "Delivery", percent: "70%", amount: "€16,380.00" },
    ]);
  });

  test("compares the totals", () => {
    expect(pricingBlock(doc).comparison?.rows).toEqual([
      { label: "Pricing", values: ["Fixed price", "Range with a ceiling"] },
      { label: "Hours", values: ["128", "128 – 192"] },
      { label: "Total", values: ["€23,400.00", "€23,400.00 – €35,100.00"] },
    ]);
  });
});

describe("one scenario", () => {
  test("has no comparison and no split by type of work with one product", () => {
    const doc = quoteDocument(
      input(content([scenario([item(DEVELOPMENT, 8)])])),
    );
    const block = pricingBlock(doc);
    expect(block.comparison).toBeNull();
    expect(block.scenarios[0]!.products).toEqual([]);
  });

  test("a line whose product has no rate shows no price", () => {
    const doc = plain(
      quoteDocument(input(content([scenario([item("p-unknown", 8)])]))),
    ) as ReturnType<typeof quoteDocument>;
    expect(items(pricingBlock(doc).scenarios[0]!.rows)[0]).toMatchObject({
      rate: "–",
      amount: "€0.00",
    });
  });
});

describe("VAT", () => {
  const c = content([scenario([item(DEVELOPMENT, 8)])]);

  test("amounts exclude VAT, and a Belgian customer gets nothing more", () => {
    expect(quoteDocument(input(c)).notes).toEqual(["All amounts exclude VAT."]);
  });

  test("a customer abroad gets the reverse-charge note", () => {
    expect(
      quoteDocument(input(c, { customerCountryCode: "nl", language: "nl" }))
        .notes,
    ).toEqual([
      "Alle bedragen zijn exclusief btw.",
      "Btw verlegd: de medecontractant is tot voldoening van de btw gehouden.",
    ]);
  });

  test("a customer with no country gets no reverse-charge note", () => {
    expect(
      quoteDocument(input(c, { customerCountryCode: null })).notes,
    ).toHaveLength(1);
  });
});

describe("labels", () => {
  test("a team's own label replaces the default in its language only", () => {
    const c = content([scenario([item(DEVELOPMENT, 8)])]);
    const labels = { en: { estimate: "Our estimate.", unknown: "x" }, nl: {} };
    expect(quoteDocument(input(c, { labels })).statement).toBe("Our estimate.");
    expect(quoteDocument(input(c, { labels, language: "nl" })).statement).toBe(
      "Indicatieve raming, geen bindend aanbod.",
    );
  });

  test("an empty label falls back to the default", () => {
    const c = content([scenario([item(DEVELOPMENT, 8)])]);
    expect(
      quoteDocument(input(c, { labels: { en: { estimate: " " } } })).statement,
    ).toBe("Indicative estimate, not a binding offer.");
  });
});
