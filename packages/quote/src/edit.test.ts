import { describe, expect, test } from "bun:test";
import { parseQuoteContent, type QuoteContent, type Scenario } from "./content";
import {
  duplicateScenario,
  markRecommended,
  newLine,
  newScenario,
  removeScenario,
  withKind,
  withPricing,
} from "./edit";

function ids() {
  let next = 0;
  return () => `id-${++next}`;
}

function item(id: string, hours = 8) {
  return {
    id,
    type: "item" as const,
    title: "Workshop",
    description: null,
    workTypeId: "wt-1",
    hours,
    hoursMax: null,
    optional: false,
    once: false,
  };
}

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    ...newScenario({ kind: "project", name: "Fixed price", newId: () => "s1" }),
    lines: [{ id: "l1", type: "section", title: "Analysis" }, item("l2")],
    ...overrides,
  };
}

function content(scenarios: Scenario[]): QuoteContent {
  return {
    blocks: [{ id: "b1", type: "pricing" }],
    rates: { workTypeRates: {}, volumeTiers: [], termTiers: [] },
    displayUnit: "hours",
    hoursPerDay: 8,
    scenarios,
  };
}

describe("newScenario", () => {
  test("a project scenario has no recurrence, so a project quote accepts it", () => {
    const created = newScenario({ kind: "project", name: "A", newId: ids() });

    expect(created.recurrence).toBeNull();
    expect(() =>
      parseQuoteContent(content([created]), "project"),
    ).not.toThrow();
  });

  test("a recurring scenario has one, so a recurring quote accepts it", () => {
    const created = newScenario({ kind: "recurring", name: "A", newId: ids() });

    expect(created.recurrence).not.toBeNull();
    expect(() =>
      parseQuoteContent(content([created]), "recurring"),
    ).not.toThrow();
  });
});

describe("withKind", () => {
  test("switching to recurring gives every scenario a recurrence", () => {
    const switched = withKind(
      content([scenario(), scenario({ id: "s2", lines: [] })]),
      "recurring",
    );

    expect(switched.scenarios.every((s) => s.recurrence !== null)).toBe(true);
    expect(() => parseQuoteContent(switched, "recurring")).not.toThrow();
  });

  test("a scenario that already recurs keeps its own term", () => {
    const recurring = scenario({
      recurrence: {
        period: "year",
        termMonths: 24,
        billing: "in_arrears",
        autoRenew: true,
        noticeMonths: 3,
      },
    });

    const switched = withKind(content([recurring]), "recurring");

    expect(switched.scenarios[0]!.recurrence).toEqual(recurring.recurrence);
  });

  test("switching to project clears every recurrence", () => {
    const recurring = withKind(content([scenario()]), "recurring");

    const switched = withKind(recurring, "project");

    expect(switched.scenarios[0]!.recurrence).toBeNull();
    expect(() => parseQuoteContent(switched, "project")).not.toThrow();
  });
});

describe("duplicateScenario", () => {
  test("the copy follows the original, with its own ids throughout", () => {
    const original = scenario({ recommended: true });
    const other = scenario({ id: "s9", lines: [] });

    const result = duplicateScenario(content([original, other]), "s1", ids());

    expect(result.scenarios.map((s) => s.id)).toEqual(["s1", "id-1", "s9"]);
    const copy = result.scenarios[1]!;
    expect(copy.name).toBe("Fixed price (copy)");
    expect(copy.lines.map((l) => l.id)).toEqual(["id-2", "id-3"]);
    expect(copy.lines.map(({ id: _, ...rest }) => rest)).toEqual(
      original.lines.map(({ id: _, ...rest }) => rest),
    );
    expect(() => parseQuoteContent(result, "project")).not.toThrow();
  });

  test("the copy is not also recommended", () => {
    const result = duplicateScenario(
      content([scenario({ recommended: true })]),
      "s1",
      ids(),
    );

    expect(result.scenarios.map((s) => s.recommended)).toEqual([true, false]);
  });

  test("editing the copy leaves the original alone", () => {
    const original = scenario();
    const result = duplicateScenario(content([original]), "s1", ids());

    const copy = result.scenarios[1]!;
    copy.paymentSchedule.push({ label: "Upfront", percent: 30 });

    expect(result.scenarios[0]!.paymentSchedule).toEqual([]);
  });

  test("an unknown scenario changes nothing", () => {
    const before = content([scenario()]);

    expect(duplicateScenario(before, "nope", ids())).toEqual(before);
  });
});

describe("removeScenario", () => {
  test("takes the scenario out and keeps the rest in order", () => {
    const result = removeScenario(
      content([
        scenario(),
        scenario({ id: "s2", lines: [] }),
        scenario({ id: "s3", lines: [] }),
      ]),
      "s2",
    );

    expect(result.scenarios.map((s) => s.id)).toEqual(["s1", "s3"]);
  });
});

describe("markRecommended", () => {
  test("one scenario is recommended at a time", () => {
    const result = markRecommended(
      content([
        scenario({ recommended: true }),
        scenario({ id: "s2", lines: [] }),
      ]),
      "s2",
      true,
    );

    expect(result.scenarios.map((s) => s.recommended)).toEqual([false, true]);
  });

  test("the mark can be taken off, leaving none recommended", () => {
    const result = markRecommended(
      content([scenario({ recommended: true })]),
      "s1",
      false,
    );

    expect(result.scenarios[0]!.recommended).toBe(false);
  });
});

describe("withPricing", () => {
  test("going fixed drops the maximums and the cap", () => {
    const range = scenario({
      pricing: "range",
      capped: true,
      lines: [{ ...item("l1"), hoursMax: 12 }],
    });

    const fixed = withPricing(range, "fixed");

    expect(fixed.pricing).toBe("fixed");
    expect(fixed.capped).toBe(false);
    expect(fixed.lines[0]).toMatchObject({ hours: 8, hoursMax: null });
  });

  test("going range keeps the hours as the minimum", () => {
    const range = withPricing(scenario(), "range");

    expect(range.pricing).toBe("range");
    expect(range.lines[1]).toMatchObject({ hours: 8, hoursMax: null });
  });
});

describe("newLine", () => {
  test("an item starts empty, on the work type given", () => {
    expect(newLine("item", { newId: () => "l1", workTypeId: "wt-2" })).toEqual({
      id: "l1",
      type: "item",
      title: "",
      description: null,
      workTypeId: "wt-2",
      hours: 0,
      hoursMax: null,
      optional: false,
      once: false,
    });
  });

  test("a section and a note start empty", () => {
    expect(newLine("section", { newId: () => "l1" })).toEqual({
      id: "l1",
      type: "section",
      title: "",
    });
    expect(newLine("note", { newId: () => "l2" })).toEqual({
      id: "l2",
      type: "note",
      text: "",
    });
  });
});
