import type {
  Line,
  QuoteContent,
  QuoteKind,
  Recurrence,
  Scenario,
} from "./content";

/**
 * The edits the quote editor makes to a version's content (FF-1611), kept
 * pure so every one of them leaves content that `parseQuoteContent` accepts
 * for the quote's kind. The editor applies them to its own copy and saves the
 * result whole.
 */

type NewId = () => string;

/** What a scenario on a recurring quote starts with. */
export const DEFAULT_RECURRENCE: Recurrence = {
  period: "month",
  termMonths: 12,
  billing: "in_advance",
  autoRenew: false,
  noticeMonths: null,
};

export function newScenario(params: {
  kind: QuoteKind;
  name: string;
  newId: NewId;
}): Scenario {
  return {
    id: params.newId(),
    name: params.name,
    recommended: false,
    pricing: "fixed",
    capped: false,
    recurrence: params.kind === "recurring" ? { ...DEFAULT_RECURRENCE } : null,
    adjustmentOverride: null,
    paymentSchedule: [],
    lines: [],
  };
}

/**
 * Content fit for a quote of this kind: every scenario on a recurring quote
 * recurs, none on a project does. A switch of kind is saved together with
 * this, or the save is refused.
 */
export function withKind(content: QuoteContent, kind: QuoteKind): QuoteContent {
  return {
    ...content,
    scenarios: content.scenarios.map((scenario) => ({
      ...scenario,
      recurrence:
        kind === "recurring"
          ? (scenario.recurrence ?? { ...DEFAULT_RECURRENCE })
          : null,
    })),
  };
}

/**
 * A copy of the scenario right after it, with new ids for it and its lines,
 * so it can be changed on its own: another term, another rate, range instead
 * of fixed (R4). The original stays the recommended one, if it was.
 */
export function duplicateScenario(
  content: QuoteContent,
  scenarioId: string,
  newId: NewId,
): QuoteContent {
  const index = content.scenarios.findIndex((s) => s.id === scenarioId);
  const original = content.scenarios[index];
  if (!original) return content;

  const copy: Scenario = {
    ...structuredClone(original),
    id: newId(),
    name: `${original.name} (copy)`,
    recommended: false,
  };
  copy.lines = copy.lines.map((line) => ({ ...line, id: newId() }));

  const scenarios = [...content.scenarios];
  scenarios.splice(index + 1, 0, copy);
  return { ...content, scenarios };
}

export function removeScenario(
  content: QuoteContent,
  scenarioId: string,
): QuoteContent {
  return {
    ...content,
    scenarios: content.scenarios.filter((s) => s.id !== scenarioId),
  };
}

/** One scenario is recommended at a time, or none. */
export function markRecommended(
  content: QuoteContent,
  scenarioId: string,
  recommended: boolean,
): QuoteContent {
  return {
    ...content,
    scenarios: content.scenarios.map((scenario) => ({
      ...scenario,
      recommended:
        scenario.id === scenarioId
          ? recommended
          : recommended
            ? false
            : scenario.recommended,
    })),
  };
}

/**
 * Fixed or range. A fixed scenario has no maximums and nothing to cap; a
 * range starts from the hours it had, as its minimums.
 */
export function withPricing(
  scenario: Scenario,
  pricing: Scenario["pricing"],
): Scenario {
  if (pricing === "range") return { ...scenario, pricing };
  return {
    ...scenario,
    pricing,
    capped: false,
    lines: scenario.lines.map((line) =>
      line.type === "item" ? { ...line, hoursMax: null } : line,
    ),
  };
}

export function newLine(
  type: Line["type"],
  params: { newId: NewId; productId?: string },
): Line {
  const id = params.newId();
  switch (type) {
    case "section":
      return { id, type, title: "" };
    case "note":
      return { id, type, text: "" };
    case "item":
      return {
        id,
        type,
        title: "",
        description: null,
        productId: params.productId ?? "",
        hours: 0,
        hoursMax: null,
        optional: false,
        once: false,
      };
  }
}
