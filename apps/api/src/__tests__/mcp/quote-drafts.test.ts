import "../setup";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  getPricedQuote,
  getQuote,
  getQuoteProducts,
  QuoteInputError,
  updateQuoteDraft,
} from "@midday/db/queries";
import { parseQuoteContent, type QuoteContent } from "@midday/quote";
import { createMcpServer } from "../../mcp/server";
import {
  removeLine,
  removeScenario,
  resolveProduct,
  setRates,
  upsertLine,
  upsertScenario,
} from "../../mcp/tools/quote-drafts";
import type { McpContext } from "../../mcp/types";
import { asMock } from "../setup";

const products = [
  { id: "p-dev", name: "Development" },
  { id: "p-design", name: "Design" },
];

/** Shown in days of 8 hours, one fixed scenario: a section and an item. */
const content = (extra: Partial<QuoteContent> = {}): QuoteContent => ({
  blocks: [],
  rates: { productRates: {}, volumeTiers: [], termTiers: [] },
  displayUnit: "days",
  hoursPerDay: 8,
  scenarios: [
    {
      id: "s1",
      name: "Fixed",
      recommended: true,
      pricing: "fixed",
      capped: false,
      recurrence: null,
      adjustmentOverride: null,
      paymentSchedule: [],
      lines: [
        { id: "sec", type: "section", title: "Build" },
        {
          id: "l1",
          type: "item",
          title: "Pages",
          description: null,
          productId: "p-dev",
          hours: 12,
          hoursMax: null,
          optional: false,
          once: false,
        },
      ],
    },
  ],
  ...extra,
});

const ids = () => {
  let n = 0;
  return () => `new-${++n}`;
};

const linesOf = (c: QuoteContent, scenarioId = "s1") =>
  c.scenarios.find((s) => s.id === scenarioId)!.lines;

describe("a product", () => {
  test("is named by id, or by its name in any case", () => {
    expect(resolveProduct(products, "p-design")).toBe("p-design");
    expect(resolveProduct(products, " development ")).toBe("p-dev");
  });

  test("that is not there is refused with the ones that are", () => {
    expect(() => resolveProduct(products, "Hosting")).toThrow(
      'No product "Hosting". Products: Development, Design',
    );
  });

  test("named twice must be named by id", () => {
    expect(() =>
      resolveProduct(
        [...products, { id: "p-dev-2", name: "development" }],
        "Development",
      ),
    ).toThrow(/by id/);
  });
});

describe("a scenario", () => {
  test("added takes a new id and goes last; recommending it stops recommending the other", () => {
    const { content: next, scenarioId } = upsertScenario(
      content(),
      "project",
      { name: "Range", pricing: "range", capped: true, recommended: true },
      ids(),
    );

    expect(scenarioId).toBe("new-1");
    expect(next.scenarios.map((s) => [s.id, s.recommended])).toEqual([
      ["s1", false],
      ["new-1", true],
    ]);
    expect(next.scenarios[1]).toMatchObject({
      name: "Range",
      pricing: "range",
      capped: true,
      recurrence: null,
      lines: [],
    });
    expect(() => parseQuoteContent(next, "project")).not.toThrow();
  });

  test("changed keeps its lines and changes only what is given", () => {
    const { content: next } = upsertScenario(content(), "project", {
      scenarioId: "s1",
      adjustmentOverride: -10,
      paymentSchedule: [
        { label: "Start", percent: 30 },
        { label: "Delivery", percent: 70 },
      ],
    });

    expect(next.scenarios[0]).toMatchObject({
      name: "Fixed",
      recommended: true,
      adjustmentOverride: -10,
      lines: content().scenarios[0]!.lines,
    });
  });

  test("going back to fixed takes the maximums and the cap away", () => {
    const range = upsertScenario(content(), "project", {
      scenarioId: "s1",
      pricing: "range",
      capped: true,
    }).content;
    const withMax = upsertLine(
      range,
      "project",
      { lineId: "l1", quantityMax: 2 },
      products,
    ).content;
    expect(linesOf(withMax)[1]).toMatchObject({ hours: 12, hoursMax: 16 });

    const fixed = upsertScenario(withMax, "project", {
      scenarioId: "s1",
      pricing: "fixed",
    }).content;
    expect(fixed.scenarios[0]!.capped).toBe(false);
    expect(linesOf(fixed)[1]).toMatchObject({ hoursMax: null });
  });

  test("on a recurring quote comes with a period and term, and changes only what is given", () => {
    const { content: next } = upsertScenario(
      content({ scenarios: [] }),
      "recurring",
      { name: "Retainer", recurrence: { period: "quarter", termMonths: 24 } },
      ids(),
    );

    expect(next.scenarios[0]!.recurrence).toEqual({
      period: "quarter",
      termMonths: 24,
      billing: "in_advance",
      autoRenew: false,
      noticeMonths: null,
    });
    expect(() => parseQuoteContent(next, "recurring")).not.toThrow();
  });

  test("refuses what its quote's kind cannot have, in words", () => {
    expect(() =>
      upsertScenario(content(), "project", {
        scenarioId: "s1",
        recurrence: { period: "month" },
      }),
    ).toThrow("A scenario on a project quote does not recur");
    expect(() =>
      upsertScenario(content({ scenarios: [] }), "recurring", {
        paymentSchedule: [],
      }),
    ).toThrow("Only a project quote has a payment schedule");
    expect(() =>
      upsertScenario(content(), "project", { scenarioId: "s1", capped: true }),
    ).toThrow("Only a range scenario can be capped");
  });

  test("that is not on the draft is refused, not added", () => {
    expect(() =>
      upsertScenario(content(), "project", { scenarioId: "s9", name: "X" }),
    ).toThrow("This draft has no scenario s9");
    expect(() => removeScenario(content(), "s9")).toThrow(/no scenario s9/);
  });

  test("removed takes its lines with it", () => {
    expect(removeScenario(content(), "s1").scenarios).toEqual([]);
  });
});

describe("a line", () => {
  test("added in days on a quote shown in days is stored as hours, last, with a new id", () => {
    const { content: next, lineId } = upsertLine(
      content(),
      "project",
      {
        scenarioId: "s1",
        title: "Checkout",
        product: "design",
        quantity: 2.5,
      },
      products,
      ids(),
    );

    expect(lineId).toBe("new-1");
    expect(linesOf(next).at(-1)).toEqual({
      id: "new-1",
      type: "item",
      title: "Checkout",
      description: null,
      productId: "p-design",
      hours: 20,
      hoursMax: null,
      optional: false,
      once: false,
    });
    expect(() => parseQuoteContent(next, "project")).not.toThrow();
  });

  test("in hours on a quote shown in hours is stored as given", () => {
    const next = upsertLine(
      content({ displayUnit: "hours" }),
      "project",
      { lineId: "l1", quantity: 3.5 },
      products,
    ).content;
    expect(linesOf(next)[1]).toMatchObject({ hours: 3.5 });
  });

  test("changed keeps its place and every other id, or moves to the index given", () => {
    const changed = upsertLine(
      content(),
      "project",
      { lineId: "l1", title: "All pages", optional: true },
      products,
    ).content;
    expect(linesOf(changed).map((l) => l.id)).toEqual(["sec", "l1"]);
    expect(linesOf(changed)[1]).toMatchObject({
      title: "All pages",
      optional: true,
      hours: 12,
      productId: "p-dev",
    });

    const moved = upsertLine(
      changed,
      "project",
      { lineId: "l1", index: 0 },
      products,
    ).content;
    expect(linesOf(moved).map((l) => l.id)).toEqual(["l1", "sec"]);
  });

  test("a section and a note take their own fields, and no others", () => {
    const withNote = upsertLine(
      content(),
      "project",
      { scenarioId: "s1", type: "note", text: "Hosting is extra", index: 1 },
      products,
      ids(),
    ).content;
    expect(linesOf(withNote).map((l) => l.id)).toEqual(["sec", "new-1", "l1"]);
    expect(linesOf(withNote)[1]).toEqual({
      id: "new-1",
      type: "note",
      text: "Hosting is extra",
    });

    expect(() =>
      upsertLine(content(), "project", { lineId: "sec", quantity: 2 }, []),
    ).toThrow("A section line has no quantity");
    expect(() =>
      upsertLine(content(), "project", { lineId: "l1", text: "x" }, []),
    ).toThrow("An item line has no text");
  });

  test("refuses what its scenario or quote cannot have", () => {
    expect(() =>
      upsertLine(content(), "project", { lineId: "l1", quantityMax: 3 }, []),
    ).toThrow(/fixed scenario has no maximum/);
    expect(() =>
      upsertLine(content(), "project", { lineId: "l1", once: true }, []),
    ).toThrow("Only a line on a recurring quote is charged once");
    expect(() =>
      upsertLine(
        content(),
        "project",
        { scenarioId: "s1", title: "No product" },
        products,
      ),
    ).toThrow("An item line needs a product");
    expect(() =>
      upsertLine(content(), "project", { title: "Where?" }, products),
    ).toThrow("A new line needs the scenario it goes in");
    expect(() =>
      upsertLine(content(), "project", { lineId: "sec", type: "item" }, []),
    ).toThrow(/its type does not change/);
  });

  test("removed leaves the other lines and their ids as they were", () => {
    const before = content();
    const next = removeLine(before, "sec");
    expect(linesOf(next)).toEqual([linesOf(before)[1]!]);
    expect(() => removeLine(before, "l9")).toThrow("This draft has no line l9");
  });
});

describe("the rates", () => {
  test("set a product's rate by name, take one away with null, and replace a tier list whole", () => {
    const start = content({
      rates: {
        productRates: { "p-design": 90 },
        volumeTiers: [{ minHours: 40, percent: -5 }],
        termTiers: [{ minMonths: 12, percent: -3 }],
      },
    });

    const next = setRates(
      start,
      {
        productRates: [
          { product: "Development", hourlyRate: 110 },
          { product: "p-design", hourlyRate: null },
        ],
        volumeTiers: [{ minHours: 80, percent: -10 }],
      },
      products,
    );

    expect(next.rates).toEqual({
      productRates: { "p-dev": 110 },
      volumeTiers: [{ minHours: 80, percent: -10 }],
      termTiers: [{ minMonths: 12, percent: -3 }],
    });
  });
});

const Q = "a1b2c3d4-0000-4000-8000-000000000001";

function tools() {
  const s = createMcpServer({
    db: {} as McpContext["db"],
    teamId: "test-team-id",
    userId: "test-user-id",
    userEmail: "test@example.com",
    scopes: ["invoices.read", "invoices.write"],
    apiUrl: "https://api.example.test",
    timezone: "UTC",
    locale: "en",
    countryCode: "BE",
    dateFormat: null,
    timeFormat: 24,
  });
  return (
    s as unknown as {
      _registeredTools: Record<
        string,
        {
          inputSchema: { parse: (args: unknown) => unknown };
          handler: (
            args: unknown,
            extra: unknown,
          ) => Promise<{ isError?: boolean; content: { text: string }[] }>;
        }
      >;
    }
  )._registeredTools;
}

async function call(name: string, args: Record<string, unknown>) {
  const tool = tools()[name]!;
  return tool.handler(tool.inputSchema.parse(args), {});
}

describe("the draft tools", () => {
  beforeEach(() => {
    asMock(getQuote).mockReset();
    asMock(getQuote).mockImplementation(() =>
      Promise.resolve({
        id: Q,
        kind: "project",
        versions: [
          { id: "v2", status: "draft", content: content() },
          { id: "v1", status: "sent", content: content() },
        ],
      }),
    );
    asMock(updateQuoteDraft).mockReset();
    asMock(updateQuoteDraft).mockImplementation(() =>
      Promise.resolve({ id: Q }),
    );
    asMock(getQuoteProducts).mockReset();
    asMock(getQuoteProducts).mockImplementation(() =>
      Promise.resolve(products),
    );
    asMock(getPricedQuote).mockReset();
    asMock(getPricedQuote).mockImplementation(() => Promise.resolve(null));
  });

  test("are there only with invoices.write", () => {
    const names = Object.keys(tools());
    for (const name of [
      "quotes_update_draft",
      "quotes_upsert_scenario",
      "quotes_remove_scenario",
      "quotes_upsert_line",
      "quotes_remove_line",
      "quotes_set_rates",
    ]) {
      expect(names).toContain(name);
    }
  });

  test("write the whole draft back, changed, through the draft query", async () => {
    await call("quotes_upsert_line", {
      quoteId: Q,
      scenarioId: "s1",
      title: "Checkout",
      product: "Design",
      quantity: 1,
    });

    const params = asMock(updateQuoteDraft).mock.calls[0]?.[1] as {
      teamId: string;
      versionId: string;
      content: QuoteContent;
    };
    expect(params.teamId).toBe("test-team-id");
    expect(params.versionId).toBe("v2");
    expect(linesOf(params.content).map((l) => l.id)).toEqual([
      "sec",
      "l1",
      expect.any(String),
    ]);
    expect(linesOf(params.content)[2]).toMatchObject({
      productId: "p-design",
      hours: 8,
    });
    expect(asMock(getPricedQuote).mock.calls[0]?.[1]).toMatchObject({
      id: Q,
    });
  });

  test("change the header and the unit without touching the scenarios", async () => {
    await call("quotes_update_draft", {
      quoteId: Q,
      title: "Website, phase 2",
      validUntil: "2026-12-31",
      displayUnit: "hours",
    });

    const params = asMock(updateQuoteDraft).mock.calls[0]?.[1] as {
      title: string;
      validUntil: string;
      content: QuoteContent;
    };
    expect(params).toMatchObject({
      title: "Website, phase 2",
      validUntil: "2026-12-31",
    });
    expect(params.content.displayUnit).toBe("hours");
    expect(params.content.scenarios).toEqual(content().scenarios);
  });

  test("leave the content alone when only the header changes", async () => {
    await call("quotes_update_draft", { quoteId: Q, mode: "firm" });

    const params = asMock(updateQuoteDraft).mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(params.mode).toBe("firm");
    expect(params.content).toBeUndefined();
  });

  test("switching a quote to recurring gives each scenario a period and term", async () => {
    await call("quotes_update_draft", { quoteId: Q, kind: "recurring" });

    const params = asMock(updateQuoteDraft).mock.calls[0]?.[1] as {
      kind: string;
      content: QuoteContent;
    };
    expect(params.kind).toBe("recurring");
    expect(params.content.scenarios[0]!.recurrence).toMatchObject({
      period: "month",
    });
  });

  test("a quote with no draft is refused before anything is written", async () => {
    asMock(getQuote).mockImplementation(() =>
      Promise.resolve({
        id: Q,
        kind: "project",
        versions: [{ id: "v1", status: "sent", content: content() }],
      }),
    );

    const result = await call("quotes_remove_line", {
      quoteId: Q,
      lineId: "l1",
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.content[0]!.text).toMatch(/no draft/);
    expect(asMock(updateQuoteDraft).mock.calls).toHaveLength(0);
  });

  test("an edit refused here, or by the query, comes back in its own words", async () => {
    const mine = await call("quotes_upsert_line", {
      quoteId: Q,
      lineId: "l1",
      quantityMax: 3,
    });
    expect(mine.content[0]!.text).toMatch(/fixed scenario has no maximum/);
    expect(asMock(updateQuoteDraft).mock.calls).toHaveLength(0);

    asMock(updateQuoteDraft).mockImplementation(() =>
      Promise.reject(new QuoteInputError("Only a draft can be edited")),
    );
    const theirs = await call("quotes_remove_scenario", {
      quoteId: Q,
      scenarioId: "s1",
    });
    expect(theirs).toMatchObject({ isError: true });
    expect(theirs.content[0]!.text).toBe("Only a draft can be edited");
  });

  test("look products up only when a product is named", async () => {
    await call("quotes_upsert_line", { quoteId: Q, lineId: "l1", index: 0 });
    await call("quotes_set_rates", {
      quoteId: Q,
      volumeTiers: [{ minHours: 40, percent: -5 }],
    });
    expect(asMock(getQuoteProducts).mock.calls).toHaveLength(0);
  });
});
