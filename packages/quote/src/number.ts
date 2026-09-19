/**
 * Quote numbers (FF-1609): the team's prefix and a four-digit sequence, own
 * to quotes, e.g. `OFF-0001`. The number belongs to the quote; its versions
 * share it and show as `OFF-0001 v2` from the second one on.
 */

const PAD_LENGTH = 4;

/** The number after the highest one in use, or the first one. */
export function nextQuoteNumber(prefix: string, highest: number | null) {
  return `${prefix}${String((highest ?? 0) + 1).padStart(PAD_LENGTH, "0")}`;
}

/** The trailing digits of a quote number, or null when it has none. */
export function quoteNumberSequence(quoteNumber: string): number | null {
  const match = quoteNumber.match(/(\d+)$/);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

/** How a version is referred to: `OFF-0001`, then `OFF-0001 v2`, … */
export function formatQuoteVersion(quoteNumber: string, version: number) {
  return version > 1 ? `${quoteNumber} v${version}` : quoteNumber;
}
