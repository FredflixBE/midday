/**
 * Matching a document to the payment that names it (FF-1548).
 *
 * Thirteen invoices the accountant holds have their reference printed in the bank
 * line, and the matcher never found it. Twelve of those are the same monthly
 * leasing payment, September 2025 through August 2026, about €13,900 — and they
 * fail on every axis the matcher looks at: "KBC Bank" shares nothing with
 * "Betaling Leasing 0001 0001 Be 2502981850", and the payment lands about two
 * weeks after the invoice date, past the window. The answer was sitting in the
 * description.
 *
 * A structured reference in a payment description is how Belgian direct debits,
 * leasing and structured transfers all work, so this recurs every month forever.
 */
import { describe, expect, test } from "bun:test";
import {
  MINIMUM_REFERENCE_LENGTH,
  normalizeStructuredReference,
  referenceAppearsIn,
  scoreMatch,
} from "../utils/transaction-matching";

/** The two live pairs the ticket was written from. */
const leasing = {
  reference: "0001/0001/BE/2502981850",
  bankLine: "Betaling Leasing 0001 0001 Be 2502981850",
};
const contributions = {
  reference: "381/0500/62760",
  bankLine: "381050062760",
};

describe("finding a reference in a bank line", () => {
  test("finds the leasing reference, grouped and punctuated differently", () => {
    expect(referenceAppearsIn(leasing.reference, leasing.bankLine)).toBe(true);
  });

  test("finds a reference the bank ran together into one number", () => {
    expect(
      referenceAppearsIn(contributions.reference, contributions.bankLine),
    ).toBe(true);
  });

  test("strips separators rather than replacing them with spaces", () => {
    // The matcher's older normaliser turned punctuation into spaces and left `/`
    // alone, which is why it found neither of the two above.
    expect(normalizeStructuredReference(leasing.reference)).toBe(
      "00010001BE2502981850",
    );
    expect(normalizeStructuredReference("381/0500/62760")).toBe("381050062760");
  });

  test("ignores a reference too short to be searched for", () => {
    // Four characters is right for comparing two references to each other, and
    // far too weak for a substring search over free text.
    expect(MINIMUM_REFERENCE_LENGTH).toBe(6);
    expect(referenceAppearsIn("12345", "Payment 12345 to someone")).toBe(false);
    expect(referenceAppearsIn("123456", "Payment 123456 to someone")).toBe(
      true,
    );
  });

  test("will not let a reference straddle two fields", () => {
    // Stripping separators out of a concatenation would find `123456` across the
    // boundary between a name ending 123 and a description starting 456.
    expect(referenceAppearsIn("123456", "Supplier 123", "456 Invoice")).toBe(
      false,
    );
  });

  test("searches every field it is given", () => {
    expect(
      referenceAppearsIn(
        leasing.reference,
        "KBC Bank",
        null,
        leasing.bankLine,
        null,
      ),
    ).toBe(true);
  });

  test("says nothing when there is no reference to look for", () => {
    expect(referenceAppearsIn(null, leasing.bankLine)).toBe(false);
    expect(referenceAppearsIn("", leasing.bankLine)).toBe(false);
  });
});

describe("what a reference is worth", () => {
  /** A pair that would otherwise score poorly: the names and dates disagree. */
  const weakOnEveryOtherAxis = {
    nameScore: 0.1,
    amountScore: 1,
    dateScore: 0.3,
    currencyScore: 1,
    isSameCurrency: true,
  };

  test("the reference, the amount and no rival candidate are a certain match", () => {
    const confidence = scoreMatch({
      ...weakOnEveryOtherAxis,
      isExactAmount: true,
      referenceEvidence: "identifies-one",
    });

    // The twelve leasing payments: "KBC Bank" against "Betaling Leasing …" and a
    // payment two weeks late. Both facts hold, so it is not a candidate.
    expect(confidence).toBeGreaterThanOrEqual(0.97);
  });

  test("a reference that does not single out one payment is only a suggestion", () => {
    const confidence = scoreMatch({
      ...weakOnEveryOtherAxis,
      amountScore: 0.6,
      nameScore: 0.95,
      dateScore: 1,
      isExactAmount: false,
      referenceEvidence: "inconclusive",
    });

    // Xerius reuses one structured reference across instalments: it sits on two
    // invoices of €2,406.58 and €1,214.70 while the one transaction carrying it
    // is €1,260.18. Capped below the 0.95 the bulk-confirm script requires, so a
    // person decides which assessment it belongs to.
    expect(confidence).toBeLessThan(0.95);
  });

  test("an inconclusive reference is capped even when everything else agrees", () => {
    const confidence = scoreMatch({
      nameScore: 1,
      amountScore: 0.95,
      dateScore: 1,
      currencyScore: 1,
      isSameCurrency: true,
      isExactAmount: false,
      referenceEvidence: "inconclusive",
    });

    expect(confidence).toBeLessThan(0.95);
  });

  test("no reference leaves the score exactly as it was", () => {
    const inputs = {
      nameScore: 0.9,
      amountScore: 0.95,
      dateScore: 1,
      currencyScore: 1,
      isSameCurrency: true,
      isExactAmount: false,
    };

    expect(scoreMatch({ ...inputs, referenceEvidence: "none" })).toBe(
      scoreMatch(inputs),
    );
  });

  test("several candidates satisfying the reference make none of them certain", () => {
    // A monthly leasing schedule puts one reference on every invoice and every
    // payment, and every instalment is the same amount — so reference plus
    // amount picks out twelve transactions rather than one. Measured: of 13
    // live cases where this rule disagreed with an attachment Midday had
    // already made, 10 were this, and the attached transaction carried the
    // reference too.
    const ambiguous = scoreMatch({
      nameScore: 0.95,
      amountScore: 1,
      dateScore: 1,
      currencyScore: 1,
      isSameCurrency: true,
      isExactAmount: true,
      referenceEvidence: "inconclusive",
    });

    expect(ambiguous).toBeLessThan(0.95);
  });

  test("an exact amount on its own is still not a certain match", () => {
    // Never on amount alone. FF-1499 measured the cost: two of six hand-made
    // amount guesses were wrong — €166.08 Figma to a €167.00 restaurant bill,
    // €8.10 Google to an €8.25 Slack invoice.
    const confidence = scoreMatch({
      ...weakOnEveryOtherAxis,
      isExactAmount: true,
      referenceEvidence: "none",
    });

    expect(confidence).toBeLessThan(0.97);
  });
});
