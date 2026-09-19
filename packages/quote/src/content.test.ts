import { describe, expect, test } from "bun:test";
import {
  initialQuoteContent,
  parseQuoteContent,
  type QuoteContent,
  quoteContentSchema,
  type Scenario,
} from "./content";

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: "s1",
    name: "Fixed price",
    recommended: false,
    pricing: "fixed",
    capped: false,
    recurrence: null,
    adjustmentOverride: null,
    paymentSchedule: [],
    lines: [
      { id: "l1", type: "section", title: "Analysis" },
      {
        id: "l2",
        type: "item",
        title: "Workshop",
        description: null,
        productId: "p-1",
        hours: 8,
        hoursMax: null,
        optional: false,
        once: false,
      },
    ],
    ...overrides,
  };
}

function content(overrides: Partial<QuoteContent> = {}): QuoteContent {
  return {
    blocks: [
      {
        id: "b1",
        type: "text",
        heading: "Context",
        body: { type: "doc", content: [{ type: "paragraph" }] },
      },
      { id: "b2", type: "pricing" },
    ],
    rates: { productRates: {}, volumeTiers: [], termTiers: [] },
    displayUnit: "hours",
    hoursPerDay: 8,
    scenarios: [scenario()],
    ...overrides,
  };
}

describe("quote content", () => {
  test("a well-formed project quote parses", () => {
    expect(parseQuoteContent(content(), "project")).toEqual(content());
  });

  test("a half-finished draft still parses: no scenarios, an empty title", () => {
    expect(() =>
      parseQuoteContent(content({ scenarios: [] }), "project"),
    ).not.toThrow();
    const untitled = scenario({ name: "" });
    expect(() =>
      parseQuoteContent(content({ scenarios: [untitled] }), "project"),
    ).not.toThrow();
  });

  test("a recurring quote's scenarios each need a recurrence", () => {
    expect(() => parseQuoteContent(content(), "recurring")).toThrow(
      /recurring quote/,
    );

    const recurring = scenario({
      recurrence: {
        period: "month",
        termMonths: null,
        billing: "in_advance",
        autoRenew: true,
        noticeMonths: 3,
      },
    });
    expect(() =>
      parseQuoteContent(content({ scenarios: [recurring] }), "recurring"),
    ).not.toThrow();
    expect(() =>
      parseQuoteContent(content({ scenarios: [recurring] }), "project"),
    ).toThrow(/does not recur/);
  });

  test("a range item's maximum cannot be below its minimum", () => {
    const range = scenario({
      pricing: "range",
      lines: [
        {
          id: "l1",
          type: "item",
          title: "Takeover",
          description: null,
          productId: "p-1",
          hours: 40,
          hoursMax: 30,
          optional: false,
          once: false,
        },
      ],
    });
    expect(
      quoteContentSchema.safeParse(content({ scenarios: [range] })).success,
    ).toBe(false);
  });

  test("ids are unique across blocks, scenarios and lines", () => {
    const clash = scenario({ id: "b1" });
    expect(
      quoteContentSchema.safeParse(content({ scenarios: [clash] })).success,
    ).toBe(false);
  });

  test("the scenarios appear in one place only", () => {
    const twice = content({
      blocks: [
        { id: "b1", type: "pricing" },
        { id: "b2", type: "pricing" },
      ],
    });
    expect(quoteContentSchema.safeParse(twice).success).toBe(false);
  });

  test("negative hours and a discount of 100% or more are refused", () => {
    const negative = scenario({
      lines: [
        {
          id: "l1",
          type: "item",
          title: "x",
          description: null,
          productId: "p-1",
          hours: -1,
          hoursMax: null,
          optional: false,
          once: false,
        },
      ],
    });
    expect(
      quoteContentSchema.safeParse(content({ scenarios: [negative] })).success,
    ).toBe(false);
    expect(
      quoteContentSchema.safeParse(
        content({ scenarios: [scenario({ adjustmentOverride: -100 })] }),
      ).success,
    ).toBe(false);
  });

  test("an unknown line type is refused", () => {
    const odd = scenario({
      lines: [{ id: "l1", type: "picture" } as never],
    });
    expect(
      quoteContentSchema.safeParse(content({ scenarios: [odd] })).success,
    ).toBe(false);
  });

  describe("a new quote's content", () => {
    let n = 0;
    const newId = () => `id-${++n}`;

    test("copies the team's blocks with fresh ids, and adds where the pricing goes", () => {
      const result = initialQuoteContent({
        defaultBlocks: [
          {
            id: "template",
            type: "text",
            heading: "Licences",
            body: { type: "doc", content: [] },
          },
        ],
        hoursPerDay: 7.5,
        newId,
      });

      expect(result.blocks.map((b) => b.type)).toEqual(["text", "pricing"]);
      expect(result.blocks[0]?.id).not.toBe("template");
      expect(result.hoursPerDay).toBe(7.5);
      expect(result.scenarios).toEqual([]);
      expect(() => parseQuoteContent(result, "project")).not.toThrow();
    });

    test("keeps the team's pricing block where the team put it", () => {
      const result = initialQuoteContent({
        defaultBlocks: [
          { id: "p", type: "pricing" },
          {
            id: "t",
            type: "text",
            heading: null,
            body: { type: "doc", content: [] },
          },
        ],
        hoursPerDay: 8,
        newId,
      });
      expect(result.blocks.map((b) => b.type)).toEqual(["pricing", "text"]);
    });
  });
});
