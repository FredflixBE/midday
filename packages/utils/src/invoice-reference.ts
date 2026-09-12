/**
 * The one rule for deciding that two invoice numbers are the same number.
 *
 * Invoice numbers are the only exact key the Yuki integration has (FF-1493).
 * Amounts cannot serve: $20 is €17.21 in one system and €17.19 in the other,
 * two correct conversions made at different times. Dates cannot either: the
 * same invoice was dated 7 and 14 days apart in Yuki and in Midday. The number
 * is the same in both, every time it was checked.
 *
 * But it is not the same *string* in both. `#SBIE-1234` and `SBIE-1234` are one
 * invoice written twice — a supplier's own prefix, an OCR pass that kept the
 * hash, a human who typed a space. So comparison happens on a normalised copy:
 * everything that is not a letter or a digit removed, and the rest upper-cased.
 *
 * Measured against the 778 invoice documents in a real Yuki archive
 * (2026-09-12): normalising merged exactly one pair of raw references, and that
 * pair differed only in the case of a leading letter — the same supplier's same
 * invoice. It merged no two genuinely different numbers. Four normalised
 * numbers are held by more than one document, and in every case by documents of
 * the *same* contact, so a lookup answers with a list rather than at most one
 * row.
 *
 * The shortest number in that archive normalises to **four characters**. A
 * match on a number that short is weak evidence, which is why this function
 * reports the comparable form and nothing more: whether a match is strong
 * enough to act on is the caller's decision, not a string function's.
 */
export function normalizeInvoiceReference(reference: string): string {
  return reference.replace(/[^0-9a-z]/gi, "").toUpperCase();
}

/**
 * Whether a reference carries anything that can be compared at all.
 *
 * A reference of only punctuation normalises to the empty string, and an empty
 * string matches every other empty string — so a lookup that accepted one would
 * answer "Yuki already has this invoice" for every document Yuki holds with no
 * usable number. Callers that build a query from a reference check this first.
 */
export function isComparableInvoiceReference(reference: string): boolean {
  return normalizeInvoiceReference(reference).length > 0;
}
