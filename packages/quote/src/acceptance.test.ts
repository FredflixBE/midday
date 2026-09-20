/**
 * What may be recorded as a client's answer (FF-1615): the scenario and the
 * optional items have to be ones the version offered.
 */
import { describe, expect, test } from "bun:test";
import { acceptanceProblem, optionalLinesOf } from "./acceptance";
import type { ItemLine, QuoteContent, Scenario } from "./content";

const WORK = "p-work";

function item(id: string, optional: boolean): ItemLine {
  return {
    id,
    type: "item",
    title: "Work",
    description: null,
    productId: WORK,
    hours: 10,
    hoursMax: null,
    optional,
    once: false,
  };
}

function scenario(id: string, lines: Scenario["lines"]): Scenario {
  return {
    id,
    name: `Scenario ${id}`,
    recommended: false,
    pricing: "fixed",
    capped: false,
    recurrence: null,
    adjustmentOverride: null,
    paymentSchedule: [],
    lines,
  };
}

const CONTENT: QuoteContent = {
  blocks: [],
  rates: { productRates: {}, volumeTiers: [], termTiers: [] },
  displayUnit: "hours",
  hoursPerDay: 8,
  scenarios: [
    scenario("s1", [
      { id: "sec", type: "section", title: "Build" },
      item("base", false),
      item("extra", true),
      item("training", true),
    ]),
    scenario("s2", [item("other", true)]),
  ],
};

describe("the optional items a scenario offers", () => {
  test("are its optional item lines, in order", () => {
    expect(optionalLinesOf(CONTENT.scenarios[0]!).map((l) => l.id)).toEqual([
      "extra",
      "training",
    ]);
  });

  test("leave out sections, notes and the items that are not optional", () => {
    expect(optionalLinesOf(scenario("s3", []))).toEqual([]);
  });
});

describe("recording an answer", () => {
  test("holds for a scenario the version offers, with no extras", () => {
    expect(
      acceptanceProblem(CONTENT, { scenarioId: "s1", optionalLineIds: [] }),
    ).toBeNull();
  });

  test("holds for every optional item of that scenario", () => {
    expect(
      acceptanceProblem(CONTENT, {
        scenarioId: "s1",
        optionalLineIds: ["extra", "training"],
      }),
    ).toBeNull();
  });

  test("is refused for a scenario the version does not offer", () => {
    expect(
      acceptanceProblem(CONTENT, { scenarioId: "s9", optionalLineIds: [] }),
    ).toBe("That scenario is not one this version offers");
  });

  test("is refused for an optional item of another scenario", () => {
    expect(
      acceptanceProblem(CONTENT, {
        scenarioId: "s1",
        optionalLineIds: ["other"],
      }),
    ).toBe("An optional item taken is not one this scenario offers");
  });

  test("is refused for an item that was never optional", () => {
    expect(
      acceptanceProblem(CONTENT, {
        scenarioId: "s1",
        optionalLineIds: ["base"],
      }),
    ).toBe("An optional item taken is not one this scenario offers");
  });
});
