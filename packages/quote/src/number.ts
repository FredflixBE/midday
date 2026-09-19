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

/**
 * The sequence of a number under this prefix: what follows the prefix, when
 * that is all digits. Null for a number under another prefix. Reading only
 * past the prefix is what lets a prefix end in digits (`Q2026`).
 */
export function quoteNumberSequence(
  quoteNumber: string,
  prefix: string,
): number | null {
  if (!quoteNumber.startsWith(prefix)) return null;
  const rest = quoteNumber.slice(prefix.length);
  return /^\d+$/.test(rest) ? Number.parseInt(rest, 10) : null;
}

/** How a version is referred to: `OFF-0001`, then `OFF-0001 v2`, … */
export function formatQuoteVersion(quoteNumber: string, version: number) {
  return version > 1 ? `${quoteNumber} v${version}` : quoteNumber;
}
