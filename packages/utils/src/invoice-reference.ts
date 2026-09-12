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
 * It lives in `utils` rather than in `@midday/yuki` because both sides of the
 * comparison need it and they are in different packages: Yuki's `Reference`
 * (`@midday/yuki/archive`), and the number Midday extracted, which FF-1493
 * must find in the PDF's own text layer before trusting it. Two copies of this
 * rule would drift, and the drift would show up as a duplicate upload.
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
 * match on a number that short is weak evidence, which is why this reports the
 * comparable form and nothing more: whether a match is strong enough to act on
 * is the caller's decision, not a string function's.
 */

/**
 * The comparable form of a reference, or **null when there is nothing to
 * compare**.
 *
 * The null case is the load-bearing one. A reference made only of punctuation
 * normalises to the empty string, and so does every document with no reference
 * at all — 900 of the 1,815 in the measured archive. An empty string equals
 * every other empty string, so a caller that keyed on one would conclude that
 * Yuki already holds every unnumbered document it has, and the invoices behind
 * them would never be sent.
 *
 * Returning `null` rather than `""` is what makes that case impossible to use
 * by accident: it has to be handled before the value can be compared.
 */
export function comparableInvoiceReference(reference: string): string | null {
  // Unicode letters, not just a-z: stripping an accented letter would merge
  // "INVÉ1" into "INV1" and report two different numbers as one. No reference
  // in the measured archive has a non-ASCII character in it, so this changes
  // nothing today — it is here so that the first one that does is not silently
  // turned into somebody else's invoice.
  const normalized = reference.replace(/[^\p{L}\p{N}]/gu, "").toUpperCase();
  return normalized === "" ? null : normalized;
}
