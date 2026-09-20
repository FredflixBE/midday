import type { Acceptance } from "./acceptance";
import type { QuoteContent } from "./content";
import { PERIODS_PER_YEAR, type PricingResult } from "./pricing";

/**
 * What an accepted quote is worth as a tracker project (FF-1617,
 * docs/quotes.md §8.7). A tracker project carries one rate and an estimate
 * in whole hours, so the scenario that was accepted is flattened to both:
 *
 * - **Hours**: the maximum for a range, because that is what was agreed as
 *   the ceiling; per year for a recurring scenario, with its one-off items
 *   counted once; and the optional items that were taken counted along.
 * - **Rate**: blended — the money those hours are worth, divided by them —
 *   since the project cannot hold a rate per kind of work. Comparing hours
 *   per kind of work needs tagged tracker entries, which is later.
 */
export type QuoteBudget = {
  /** Whole hours, rounded up: the tracker's estimate is an integer. */
  estimate: number;
  /** What those hours are worth, in cents. */
  total: number;
  /** The blended hourly rate, in currency units; null without hours. */
  rate: number | null;
};

export function quoteBudget(
  content: QuoteContent,
  pricing: PricingResult,
  acceptance: Acceptance,
): QuoteBudget | null {
  const scenario = content.scenarios.find(
    (candidate) => candidate.id === acceptance.scenarioId,
  );
  const priced = pricing.scenarios.find(
    (candidate) => candidate.scenarioId === acceptance.scenarioId,
  );
  if (!scenario || !priced) return null;

  const periods = scenario.recurrence
    ? PERIODS_PER_YEAR[scenario.recurrence.period]
    : 1;
  const taken = new Set(acceptance.optionalLineIds);

  let hours = 0;
  let total = 0;
  for (const line of priced.lines) {
    if (line.optional && !taken.has(line.lineId)) continue;
    // A one-off item on a recurring scenario is charged once a year, not
    // once a period.
    const times = line.once ? 1 : periods;
    hours += (line.hoursMax ?? line.hours) * times;
    total += (line.amountMax ?? line.amount) * times;
  }

  return {
    estimate: Math.ceil(hours),
    total,
    rate: hours > 0 ? Math.round(total / hours) / 100 : null,
  };
}
