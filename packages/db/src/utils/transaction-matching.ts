import { createLoggerWithContext } from "@midday/logger";
import { parseISO } from "date-fns";

const logger = createLoggerWithContext("matching");

export const CALIBRATION_LIMITS = {
  MAX_ADJUSTMENT: 0.03, // Max 3% threshold adjustment per calibration
  MIN_SAMPLES_AUTO: 5, // Minimum samples for auto-match calibration
  MIN_SAMPLES_SUGGESTED: 3, // Minimum samples for suggested-match calibration
  MIN_SAMPLES_CONSERVATIVE: 8, // Higher threshold for conservative adjustments
} as const;

// Type definitions for matching utilities
type AmountComparableItem = {
  amount: number | null;
  currency: string | null;
  baseAmount?: number | null;
  baseCurrency?: string | null;
  /** What the charge originally cost, when it was made in another currency. */
  originalAmount?: number | null;
  originalCurrency?: string | null;
};

/**
 * The two amounts to compare, and whether a rate stands between them (FF-1561).
 *
 * A card charge settles in euro; the invoice behind it is in dollars. Two things
 * follow, and the matcher used to get both wrong.
 *
 * **Where the document is in the currency the charge was originally made in,
 * compare there.** Since FF-1560 the transaction carries its original amount, so
 * the comparison needs no rate at all — and on six live pending suggestions the
 * dollar amounts agree to the cent while the euro ones cannot. Those scored
 * 0.74.
 *
 * **Where both are in the settled currency, note that a rate was applied.** The
 * accountant books the invoice at the invoice-date rate and the card issuer
 * converts at its own rate on settlement day with its margin in it, so the two
 * euro figures differ *by construction*. Measured on the live books: gaps of
 * 1.99% to 2.69%, every one of them a correct match confirmed by hand. Scoring
 * that against zero is what put them at 0.89–0.94.
 *
 * Returns null when the two cannot be brought into one currency, which leaves
 * the caller to fall back to base amounts.
 */
export function alignAmounts(
  item1: AmountComparableItem,
  item2: AmountComparableItem,
): { amount1: number; amount2: number; acrossRates: boolean } | null {
  const { amount: amount1, currency: currency1 } = item1;
  const { amount: amount2, currency: currency2 } = item2;

  if (!amount1 || !amount2 || !currency1 || !currency2) return null;

  if (currency1 !== currency2) {
    // One side settled in a currency the other never used — but the charge
    // remembers what it originally cost, and that is the currency they share.
    if (item2.originalCurrency === currency1 && item2.originalAmount) {
      return {
        amount1: Math.abs(amount1),
        amount2: Math.abs(item2.originalAmount),
        acrossRates: false,
      };
    }

    if (item1.originalCurrency === currency2 && item1.originalAmount) {
      return {
        amount1: Math.abs(item1.originalAmount),
        amount2: Math.abs(amount2),
        acrossRates: false,
      };
    }

    // Both sides converted into one base currency: that comparison has its own,
    // stricter ladder in `calculateAmountScore` — tighter for large transfers —
    // and the golden dataset is scored on it. Leave it there.
    const sharedBase =
      item1.baseAmount &&
      item2.baseAmount &&
      item1.baseCurrency &&
      item1.baseCurrency === item2.baseCurrency;
    if (sharedBase) return null;

    // No original in common and no shared base, but one side's base amount is
    // in the other's currency. A foreign invoice pulled from Yuki carries the
    // accountant's booked euro as its base (FF-1572), and against a euro payment
    // with no original and no base of its own that is the comparison it was
    // always scored on — booked euro against paid euro, two conversions apart.
    if (item2.baseCurrency === currency1 && item2.baseAmount) {
      return {
        amount1: Math.abs(amount1),
        amount2: Math.abs(item2.baseAmount),
        acrossRates: true,
      };
    }

    if (item1.baseCurrency === currency2 && item1.baseAmount) {
      return {
        amount1: Math.abs(item1.baseAmount),
        amount2: Math.abs(amount2),
        acrossRates: true,
      };
    }

    return null;
  }

  const converted =
    (item1.originalCurrency != null && item1.originalCurrency !== currency1) ||
    (item2.originalCurrency != null && item2.originalCurrency !== currency2);

  return {
    amount1: Math.abs(amount1),
    amount2: Math.abs(amount2),
    acrossRates: converted,
  };
}

/**
 * Whether the two amounts are the same money, to the cent.
 *
 * One function rather than the expression that used to sit inline at each call
 * site, because that expression subtracted the two amounts whatever currency
 * they were in — so a $100 invoice and a €100 charge read as an exact match and
 * took the 0.92 floor with them (`scoreMatch` grants that floor without
 * requiring the currencies to agree).
 *
 * That is the only case this refuses. Where `alignAmounts` cannot bring the two
 * into one currency for some *other* reason — a document whose amount was
 * extracted and whose currency was not, or a pair that is genuinely zero — the
 * comparison falls back to what it did before FF-1561. Refusing those as well
 * would quietly take the floor away from matches that used to have it, which is
 * not what this ticket is for.
 */
export function isExactAmountMatch(
  item1: AmountComparableItem,
  item2: AmountComparableItem,
): boolean {
  const aligned = alignAmounts(item1, item2);
  if (aligned) return Math.abs(aligned.amount1 - aligned.amount2) < 0.01;

  const { amount: amount1, currency: currency1 } = item1;
  const { amount: amount2, currency: currency2 } = item2;

  if (amount1 == null || amount2 == null) return false;

  // Two currencies that are both known and differ, with no original to compare
  // through: whatever these two numbers are, they are not the same money.
  if (currency1 && currency2 && currency1 !== currency2) return false;

  return Math.abs(Math.abs(amount1) - Math.abs(amount2)) < 0.01;
}

/**
 * How many characters a reference must have before it is searched for inside a
 * bank description (FF-1548).
 *
 * FF-1493 compares two invoice numbers to each other and uses four, which is
 * right for that: both sides are references, so a short one is still a whole
 * one. This is a **substring search over free text**, where four characters
 * collide by accident — a bank line is full of short runs of digits. Six found
 * nothing spurious across the live set.
 */
export const MINIMUM_REFERENCE_LENGTH = 6;

/**
 * A reference reduced to what both sides can agree on: upper case, and every
 * character that is not a letter or a digit removed.
 *
 * Stripping rather than replacing is the whole point. A structured Belgian
 * reference is printed on the invoice as `0001/0001/BE/2502981850` and arrives
 * on the bank line as `Betaling Leasing 0001 0001 Be 2502981850` — the same
 * characters, grouped differently and punctuated differently. The matcher's
 * existing normaliser turns punctuation into spaces and leaves `/` alone, so it
 * finds neither of this ticket's two examples; with the separators gone both are
 * plain substrings.
 */
export function normalizeStructuredReference(
  value: string | null | undefined,
): string {
  if (!value) return "";
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Whether a document's reference is printed in a transaction's text.
 *
 * This is how a Belgian direct debit, a leasing schedule and a structured
 * transfer all identify themselves, so it recurs every month forever — twelve
 * leasing payments on the live books, about €13,900, where the supplier name
 * shares nothing with the bank line and the payment lands two weeks after the
 * invoice date. It fails on every axis the matcher looks at while the answer is
 * sitting in the description.
 */
export function referenceAppearsIn(
  reference: string | null | undefined,
  ...text: (string | null | undefined)[]
): boolean {
  const needle = normalizeStructuredReference(reference);

  if (needle.length < MINIMUM_REFERENCE_LENGTH) return false;

  // Each field on its own, never joined first. Stripping the separators out of
  // a concatenation would let a reference straddle two of them — the tail of a
  // merchant name and the head of a description forming a run of digits that
  // neither field contains.
  return text.some((field) =>
    normalizeStructuredReference(field).includes(needle),
  );
}

export const COMMON_VAT_RATES = [
  0.05, 0.06, 0.07, 0.075, 0.08, 0.1, 0.12, 0.19, 0.2, 0.21, 0.22, 0.25,
] as const;

export type MatchType = "auto_matched" | "high_confidence" | "suggested";

type CrossCurrencyComparableItem = {
  amount?: number | null;
  currency?: string | null;
  baseAmount?: number | null;
  baseCurrency?: string | null;
};

// Helper functions for cross-currency matching
export function isCrossCurrencyMatch(
  item1: CrossCurrencyComparableItem,
  item2: CrossCurrencyComparableItem,
  tolerancePercent = 0.02,
  minTolerance = 15,
): boolean {
  // Must have different currencies
  if (!item1.currency || !item2.currency || item1.currency === item2.currency) {
    return false;
  }

  // Must have same base currency
  if (
    !item1.baseCurrency ||
    !item2.baseCurrency ||
    item1.baseCurrency !== item2.baseCurrency
  ) {
    return false;
  }

  // Must have base amounts
  if (!item1.baseAmount || !item2.baseAmount) {
    return false;
  }

  const baseAmount1 = Math.abs(item1.baseAmount);
  const baseAmount2 = Math.abs(item2.baseAmount);
  const difference = Math.abs(baseAmount1 - baseAmount2);
  const avgAmount = (baseAmount1 + baseAmount2) / 2;

  // Tiered tolerance based on amount size to balance accuracy and usability
  let adjustedTolerance: number;
  let toleranceCategory: string;
  let effectiveTolerancePercent: number;

  if (avgAmount < 100) {
    // Small amounts: More conservative (rounding errors, fees, small transactions)
    adjustedTolerance = Math.max(10, avgAmount * 0.04);
    toleranceCategory = "small";
    effectiveTolerancePercent = 0.04;
  } else if (avgAmount < 1000) {
    // Medium amounts: More conservative tolerance
    adjustedTolerance = Math.max(15, avgAmount * 0.02);
    toleranceCategory = "medium";
    effectiveTolerancePercent = 0.02;
  } else {
    // Large amounts: Very strict (exchange rate should be stable)
    adjustedTolerance = Math.max(25, avgAmount * 0.015);
    toleranceCategory = "large";
    effectiveTolerancePercent = 0.015;
  }

  const isMatch = difference < adjustedTolerance;
  const actualTolerancePercent = adjustedTolerance / avgAmount;

  // Enhanced logging with risk assessment
  logger.debug("CROSS-CURRENCY MATCH DEBUG", {
    item1: {
      currency: item1.currency,
      amount: item1.amount,
      baseCurrency: item1.baseCurrency,
      baseAmount: item1.baseAmount,
    },
    item2: {
      currency: item2.currency,
      amount: item2.amount,
      baseCurrency: item2.baseCurrency,
      baseAmount: item2.baseAmount,
    },
    calculation: {
      baseAmount1,
      baseAmount2,
      difference,
      avgAmount,
      tolerance: adjustedTolerance,
      originalTolerancePercent: tolerancePercent,
      effectiveTolerancePercent,
      actualTolerancePercent,
      minTolerance,
    },
    riskAssessment: {
      amountCategory: toleranceCategory,
      isHighRisk: actualTolerancePercent > 0.1, // Flag >10% effective tolerance
      isConservative: actualTolerancePercent <= 0.05, // Flag ≤5% tolerance
      toleranceSource:
        adjustedTolerance ===
        Math.max(15, avgAmount * effectiveTolerancePercent)
          ? adjustedTolerance === 15 ||
            adjustedTolerance === 25 ||
            adjustedTolerance === 50
            ? "minimum"
            : "percentage"
          : "percentage",
    },
    result: isMatch,
  });

  return isMatch;
}

// Helper scoring functions
export function calculateAmountScore(
  item1: AmountComparableItem,
  item2: AmountComparableItem,
): number {
  // The currencies are read inside `alignAmounts`, which is what decides which
  // two numbers these are.
  const amount1 = item1.amount;
  const amount2 = item2.amount;

  if (!amount1 || !amount2) return 0.5;

  const absAmount1 = Math.abs(amount1);
  const absAmount2 = Math.abs(amount2);

  // Which two numbers are actually comparable, and whether a rate stands between
  // them (FF-1561). For a document in the currency a card charge was originally
  // made in this is the charge's original amount, where no rate is involved.
  const aligned = alignAmounts(item1, item2);

  if (aligned) {
    const maxAligned = Math.max(aligned.amount1, aligned.amount2);
    const alignedDiff =
      Math.abs(aligned.amount1 - aligned.amount2) / maxAligned;

    if (alignedDiff === 0) return 1.0;
    if (alignedDiff <= 0.01) return 0.98;

    if (aligned.acrossRates) {
      // Both sides are in the settled currency, and they got there by two
      // different rates — the accountant's for the invoice, the card issuer's
      // for the charge, margin included. A gap this size is what the two rates
      // predict rather than evidence against the match: measured at 1.99% to
      // 2.69% across the live pending band, every one confirmed correct by hand.
      //
      // Bounded deliberately. A spread is a percentage of a knowable size, so
      // this concession stops at 5% and is only ever granted to a charge that
      // was actually converted — never to two amounts in one currency that
      // simply differ.
      if (alignedDiff <= 0.03) return 0.95;
      if (alignedDiff <= 0.05) return 0.88;
      // Granted on `originalCurrency` alone, without requiring the amount: a
      // charge we know was converted got its settled figure through a rate
      // whether or not the provider told us the amount behind it. GoCardless is
      // exactly that case.
    } else {
      if (alignedDiff <= 0.02) return 0.95;
      if (alignedDiff <= 0.05) return 0.85;
    }

    if (alignedDiff <= 0.1) return 0.6;
    if (alignedDiff <= 0.2) return 0.3;

    // The VAT ladder now also runs for a pair aligned through the original,
    // which it did not before — and should: those two numbers are in one
    // currency, so a 1.21 ratio between them really is VAT rather than a rate.
    const alignedRatio =
      maxAligned / Math.max(Math.min(aligned.amount1, aligned.amount2), 1e-9);
    const alignedRatioMinusOne = alignedRatio - 1;
    for (const vatRate of COMMON_VAT_RATES) {
      if (Math.abs(alignedRatioMinusOne - vatRate) <= 0.015) {
        return 0.88;
      }
    }

    return 0;
  }

  // Cross-currency scoring should primarily use base amounts.
  const baseAmount1 = item1.baseAmount ? Math.abs(item1.baseAmount) : null;
  const baseAmount2 = item2.baseAmount ? Math.abs(item2.baseAmount) : null;
  const baseCurrency1 = item1.baseCurrency;
  const baseCurrency2 = item2.baseCurrency;

  if (
    baseAmount1 &&
    baseAmount2 &&
    baseCurrency1 &&
    baseCurrency2 &&
    baseCurrency1 === baseCurrency2
  ) {
    const maxBaseAmount = Math.max(baseAmount1, baseAmount2);
    const avgBaseAmount = (baseAmount1 + baseAmount2) / 2;
    const basePercentageDiff =
      Math.abs(baseAmount1 - baseAmount2) / maxBaseAmount;

    if (basePercentageDiff === 0) return 1.0;

    if (avgBaseAmount >= 5000) {
      // Large cross-currency: tighter scoring — exchange rate spreads
      // should be minimal for large transfers.
      if (basePercentageDiff <= 0.015) return 0.95;
      if (basePercentageDiff <= 0.03) return 0.75;
      if (basePercentageDiff <= 0.05) return 0.5;
      if (basePercentageDiff <= 0.1) return 0.3;
      return 0;
    }

    if (basePercentageDiff <= 0.02) return 0.9;
    if (basePercentageDiff <= 0.05) return 0.8;
    if (basePercentageDiff <= 0.1) return 0.65;
    if (basePercentageDiff <= 0.15) return 0.45;
    if (basePercentageDiff <= 0.25) return 0.25;
    return 0;
  }

  // Fallback for cross-currency without usable base amounts: the two numbers are
  // in different currencies and nothing says how they relate, so comparing them
  // at all is a guess. Unchanged from before FF-1561, which only ever added ways
  // to avoid reaching here.
  const maxAmount = Math.max(absAmount1, absAmount2);
  const percentageDiff = Math.abs(absAmount1 - absAmount2) / maxAmount;
  const ratio = maxAmount / Math.max(Math.min(absAmount1, absAmount2), 1e-9);
  if (ratio > 5) return 0.1;
  if (percentageDiff <= 0.05) return 0.7;
  if (percentageDiff <= 0.2) return 0.4;
  return 0.1;
}

export function calculateCurrencyScore(
  currency1?: string,
  currency2?: string,
  baseCurrency1?: string | null,
  baseCurrency2?: string | null,
): number {
  if (!currency1 || !currency2) return 0.5;

  // HIGHEST PRIORITY: Exact currency match
  if (currency1 === currency2) return 1.0;

  // Lower confidence, but still meaningful if both convert to same base currency
  // — or if one side's base is the other's currency, which is a pulled foreign
  // invoice beside a euro payment (FF-1572).
  if (
    (baseCurrency1 && baseCurrency2 && baseCurrency1 === baseCurrency2) ||
    baseCurrency1 === currency2 ||
    baseCurrency2 === currency1
  ) {
    return 0.7;
  }

  return 0.3;
}

const COMPANY_SUFFIXES = new Set([
  "inc",
  "llc",
  "ltd",
  "ab",
  "gmbh",
  "pty",
  "co",
  "corp",
  "sa",
  "srl",
  "as",
  "oy",
  "oyj",
  "ag",
  "bv",
  "nv",
  "se",
  "plc",
  "pbc",
  "sarl",
  "oü",
  "ou",
  "ug",
  "kg",
  "mbh",
  "lda",
  "limited",
  "incorporated",
  "corporation",
]);

function normalizeNameTokens(name: string): string[] {
  if (!name) return [];
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[.,\-_'"()&]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !COMPANY_SUFFIXES.has(t));
}

/**
 * Scores name similarity between an inbox display name and a transaction name/merchant.
 * Uses multiple strategies: Jaccard token overlap, substring containment, and prefix matching.
 * Takes the best score from comparing against both transactionName and merchantName.
 */
export function calculateNameScore(
  inboxName: string | null | undefined,
  transactionName: string | null | undefined,
  merchantName: string | null | undefined,
  aliasScore?: number,
): number {
  if (!inboxName) return 0;

  const inboxTokens = normalizeNameTokens(inboxName);
  if (inboxTokens.length === 0) return 0;

  const scores: number[] = [];

  for (const compareName of [merchantName, transactionName]) {
    if (!compareName) continue;

    const compareTokens = normalizeNameTokens(compareName);
    if (compareTokens.length === 0) continue;

    const inboxSet = new Set(inboxTokens);
    const compareSet = new Set(compareTokens);
    const intersection = new Set(
      [...inboxSet].filter((t) => compareSet.has(t)),
    );
    const union = new Set([...inboxSet, ...compareSet]);

    if (union.size > 0) {
      scores.push(intersection.size / union.size);
    }

    // Containment: one name fully contained in the other
    const inboxJoined = inboxTokens.join(" ");
    const compareJoined = compareTokens.join(" ");
    if (
      inboxJoined.length >= 3 &&
      compareJoined.length >= 3 &&
      (inboxJoined.includes(compareJoined) ||
        compareJoined.includes(inboxJoined))
    ) {
      scores.push(0.85);
    }

    // Prefix match: first significant token matches
    if (
      inboxTokens[0] &&
      compareTokens[0] &&
      inboxTokens[0].length >= 3 &&
      inboxTokens[0] === compareTokens[0]
    ) {
      scores.push(0.6);
    }

    // Concatenated token match handles names like "ElevenLabs" vs "Eleven Labs".
    const inboxConcatenated = inboxTokens.join("");
    const compareConcatenated = compareTokens.join("");
    if (
      inboxConcatenated.length >= 4 &&
      compareConcatenated.length >= 4 &&
      (inboxConcatenated === compareConcatenated ||
        inboxConcatenated.includes(compareConcatenated) ||
        compareConcatenated.includes(inboxConcatenated))
    ) {
      scores.push(inboxConcatenated === compareConcatenated ? 0.95 : 0.8);
    }
  }

  if (typeof aliasScore === "number" && aliasScore > 0) {
    scores.push(aliasScore);
  }

  return scores.length > 0 ? Math.max(...scores) : 0;
}

/**
 * What a document's reference establishes about a transaction (FF-1548).
 *
 * `"identifies-one"` — the reference is printed on the bank line, the amounts
 * agree, **and exactly one candidate satisfies both**. All three, which together
 * name the payment outright.
 *
 * `"inconclusive"` — the reference was found and does not single out one payment.
 * Two ways that happens, and both were measured on the live books:
 *
 * - **The amounts differ.** Xerius reuses one structured reference across
 *   instalments: it sits on two invoices of €2,406.58 and €1,214.70 while the
 *   one transaction carrying it is €1,260.18. Acting on the number alone attaches
 *   the wrong assessment.
 * - **Several candidates satisfy it equally.** A monthly leasing schedule puts
 *   one reference on every invoice and every payment, and every instalment is the
 *   same amount — so reference-plus-amount picks out twelve transactions rather
 *   than one. Of 13 live cases where this rule disagreed with an attachment
 *   Midday had already made, 10 were this: the attached transaction carried the
 *   reference too. The reference identifies the *contract*, not the instalment.
 *
 * Either way it is capped to a suggestion, for a person to settle.
 */
export type ReferenceEvidence = "identifies-one" | "inconclusive" | "none";

/** A reference that does not single out one payment stays below the bulk-confirm bar. */
const INCONCLUSIVE_REFERENCE_CEILING = 0.94;

/** A reference that names exactly one payment is as certain as this matcher gets. */
const CONCLUSIVE_REFERENCE_FLOOR = 0.97;

/**
 * How close in time an exact amount has to be before it can stand without a
 * name. Days, either direction.
 *
 * A card charge reaches the bank within a day or two of the invoice that
 * settles it, which is the case this is for. Anything wider and the amount
 * stops identifying a payment: six monthly Cursor charges of €17.38 are an
 * exact match to every one of six invoices, and only the date tells November
 * from February.
 */
const NAMELESS_MATCH_WINDOW_DAYS = 7;

type ScoreMatchInput = {
  nameScore: number;
  amountScore: number;
  dateScore: number;
  currencyScore: number;
  isSameCurrency: boolean;
  isExactAmount: boolean;
  declinePenalty?: number;
  referenceEvidence?: ReferenceEvidence;
  /**
   * Days between the document and the payment, unsigned, where the caller knows
   * it (FF-1565).
   *
   * Absent means *not known*, never *near*: `dateScore` cannot answer this,
   * because it scores plausibility rather than closeness — a payment 30 days
   * after an invoice scores 0.98 as a net-30 term while one the next day scores
   * 0.85 as an advance payment.
   */
  daysApart?: number;
};

export function scoreMatch({
  nameScore,
  amountScore,
  dateScore,
  currencyScore,
  isSameCurrency,
  isExactAmount,
  declinePenalty = 0,
  referenceEvidence = "none",
  daysApart,
}: ScoreMatchInput): number {
  // Cross-currency with a strong name match: the vendor is already identified,
  // so amount differences are mostly FX noise. Shift weight toward date to
  // disambiguate recurring charges from different months.
  const isCrossCurrencyKnownVendor = !isSameCurrency && nameScore >= 0.8;
  const amountWeight = isCrossCurrencyKnownVendor ? 20 : 30;
  const dateWeight = isCrossCurrencyKnownVendor ? 25 : 15;
  const totalWeight = 10 + amountWeight + dateWeight + 5;

  const weightedBase =
    (nameScore * 10 +
      amountScore * amountWeight +
      dateScore * dateWeight +
      currencyScore * 5) /
    totalWeight;

  let confidence = weightedBase;

  if (isExactAmount && nameScore >= 0.5 && dateScore >= 0.7) {
    confidence = Math.max(confidence, 0.92);
  } else if (isExactAmount && nameScore >= 0.3 && dateScore >= 0.5) {
    confidence = Math.max(confidence, 0.85);
  } else if (isExactAmount && isSameCurrency && dateScore >= 0.6) {
    confidence = Math.max(confidence, 0.78);
  }

  // Cross-currency additive boost instead of a hard floor — preserves the
  // natural score spread so date can still discriminate between months.
  if (
    !isSameCurrency &&
    nameScore >= 0.5 &&
    amountScore >= 0.6 &&
    dateScore >= 0.3
  ) {
    confidence = Math.max(confidence, confidence + 0.05);
  }

  // An exact amount, in the same currency, within days: the two rows are
  // Midday's own, so this is the comparison FF-1537 calls reliable — one
  // system, one source, one currency. That is documentary in the way FF-1548's
  // reference is, and like the reference it has to survive the name, not be
  // erased by it (FF-1565).
  //
  // The card statement said `TEXACO REED BE2840 REET`; the invoice came from
  // `Horbo`, the company that operates the station. Same purchase, same amount
  // to the cent, one day apart, no word in common — and the multiplier below
  // turned the floor an exact amount had just set, 0.78, into 0.429, under the
  // 0.6 a suggestion needs. A supplier trading under another name is the norm
  // for physical merchants, so a name comparison rejects those matches every
  // time, which is how this went unnoticed: it looks like caution.
  //
  // The window is what keeps it from becoming the opposite mistake. Beyond it
  // a recurring amount identifies a supplier and not a payment.
  const amountAndDateIdentify =
    isExactAmount &&
    isSameCurrency &&
    daysApart !== undefined &&
    daysApart <= NAMELESS_MATCH_WINDOW_DAYS;

  if (nameScore === 0 && !amountAndDateIdentify) {
    confidence *= 0.55;
  }

  if (dateScore < 0.2) {
    confidence *= 0.65;
  }

  // The reference is documentary evidence about this pair, so it is applied over
  // the name and date multipliers above — a reference printed on the bank line
  // is worth more than a name score of zero, which is the whole of FF-1548: the
  // twelve leasing payments share no words with their invoices at all.
  //
  // But *before* the decline penalty, deliberately. That penalty is what a
  // person has repeatedly declined for this pair of names, and a floor applied
  // after it would erase that and hand back the match they kept rejecting. The
  // order means the reference lifts the pair and their judgement still pulls it
  // down.
  if (referenceEvidence === "identifies-one") {
    confidence = Math.max(confidence, CONCLUSIVE_REFERENCE_FLOOR);
  } else if (referenceEvidence === "inconclusive") {
    confidence = Math.min(confidence, INCONCLUSIVE_REFERENCE_CEILING);
  }

  if (declinePenalty > 0) {
    confidence -= declinePenalty;
  }

  return Math.max(0, Math.min(1, confidence));
}

/**
 * Whole days between two ISO dates, unsigned.
 *
 * `calculateDateScore` cannot answer this and is not meant to: it scores how
 * *plausible* a gap is, so a payment 30 days after an invoice scores higher
 * than one the next day. Closeness is a separate question, and `scoreMatch`
 * asks it (FF-1565).
 */
export function daysBetween(one: string, other: string): number {
  return Math.round(
    Math.abs(parseISO(one).getTime() - parseISO(other).getTime()) /
      (1000 * 60 * 60 * 24),
  );
}

export function calculateDateScore(
  inboxDate: string,
  transactionDate: string,
  inboxType?: string | null,
): number {
  const inboxDateObj = parseISO(inboxDate);
  const transactionDateObj = parseISO(transactionDate);

  const diffDays = Math.abs(
    (inboxDateObj.getTime() - transactionDateObj.getTime()) /
      (1000 * 60 * 60 * 24),
  );

  // Signed difference: positive = transaction AFTER inbox date, negative = transaction BEFORE inbox date
  const signedDiffDays =
    (transactionDateObj.getTime() - inboxDateObj.getTime()) /
    (1000 * 60 * 60 * 24);

  const type = inboxType || "expense"; // Default to expense if not specified

  if (type === "invoice") {
    // INVOICE LOGIC: Payment usually comes AFTER invoice date
    // Account for 3-day open banking delay
    if (signedDiffDays > 0) {
      // Common payment terms with tolerance (adjusted for 3-day banking delay)
      if (signedDiffDays >= 24 && signedDiffDays <= 38) return 0.98; // Net 30 (27-35 days + 3-day delay)
      if (signedDiffDays >= 55 && signedDiffDays <= 68) return 0.96; // Net 60 (58-65 days + 3-day delay)
      if (signedDiffDays >= 85 && signedDiffDays <= 98) return 0.94; // Net 90 (88-95 days + 3-day delay)
      if (signedDiffDays >= 10 && signedDiffDays <= 20) return 0.95; // Net 15 (13-17 days + 3-day delay)
      if (signedDiffDays >= 3 && signedDiffDays <= 11) return 0.93; // Net 7 (6-8 days + 3-day delay)

      // Immediate payment (accounting for banking delay)
      if (signedDiffDays <= 6) return 0.99; // 0-3 days + 3-day banking delay

      // Extended payment terms (up to 120 days + delay)
      if (signedDiffDays <= 123)
        return Math.max(0.7, 0.9 - (signedDiffDays - 33) * 0.002);
    }
    // Payment BEFORE invoice (advance payment, accounting for delay)
    else if (signedDiffDays >= -10) {
      return 0.85; // Lower score for advance payments (extended for banking delay)
    }
  } else {
    // EXPENSE LOGIC: Receipt usually comes AFTER transaction
    // Account for 3-day banking delay - transaction appears 3 days after it actually happened
    if (signedDiffDays < 0) {
      // Transaction happened BEFORE receipt (normal expense flow)
      const absDays = Math.abs(signedDiffDays);
      // Adjust for banking delay - transaction actually happened ~3 days earlier
      const adjustedDays = absDays + 3;

      if (adjustedDays <= 4) return 0.99; // Same day or next day (accounting for delay)
      if (adjustedDays <= 10) return 0.95; // Within a week (accounting for delay)
      if (adjustedDays <= 33) return 0.9; // Within a month (accounting for delay)
      if (adjustedDays <= 63) return 0.8; // Within 2 months (accounting for delay)
      if (adjustedDays <= 93) return 0.7; // Very late receipt (accounting for delay)
    }
    // Receipt BEFORE transaction (less common - but account for banking delay)
    else if (signedDiffDays <= 10) {
      // Receipt up to 10 days before transaction date (accounting for 3-day delay + some tolerance)
      return 0.85; // Could be normal timing with banking delay
    }
  }

  // Standard proximity scoring
  if (diffDays === 0) return 1.0;
  if (diffDays <= 1) return 0.95;
  if (diffDays <= 3) return 0.85;
  if (diffDays <= 7) return 0.75;
  if (diffDays <= 14) return 0.6;
  if (diffDays <= 30) return Math.max(0.3, 1 - (diffDays / 30) * 0.7);

  return 0.1; // Very old = minimal score but not zero
}
