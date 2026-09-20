import type { ItemLine, QuoteContent, Scenario } from "./content";

/**
 * What a client answered (FF-1615): which scenario they took, and which of
 * its optional items came along. Acceptance arrives outside Midday — an
 * email, an order form, a PO — so it is recorded by hand, and what is
 * recorded has to point at things the version actually offered.
 */
export type Acceptance = {
  scenarioId: string;
  optionalLineIds: string[];
};

/** The optional items a scenario offers, in the order they are written. */
export function optionalLinesOf(scenario: Scenario): ItemLine[] {
  return scenario.lines.filter(
    (line): line is ItemLine => line.type === "item" && line.optional,
  );
}

/**
 * Why this acceptance does not fit the version, in one sentence, or null
 * when it does. The version is what the client holds, so an answer that
 * names a scenario it does not offer, or an extra nobody was offered, is a
 * mistake worth refusing rather than storing.
 */
export function acceptanceProblem(
  content: QuoteContent,
  acceptance: Acceptance,
): string | null {
  const scenario = content.scenarios.find(
    (candidate) => candidate.id === acceptance.scenarioId,
  );
  if (!scenario) {
    return "That scenario is not one this version offers";
  }

  const offered = new Set(optionalLinesOf(scenario).map((line) => line.id));
  if (acceptance.optionalLineIds.some((id) => !offered.has(id))) {
    return "An optional item taken is not one this scenario offers";
  }

  return null;
}
