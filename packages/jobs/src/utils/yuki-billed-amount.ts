/**
 * What a pulled invoice actually billed, when that is not what Yuki booked
 * (FF-1572).
 *
 * The pull builds an inbox row from Yuki's archive record, which carries the
 * accountant's *booked* amount in the administration's currency. For a euro
 * invoice that is exactly what was billed. For a foreign one it is a
 * conversion — Cursor's $19.95 booked as €17.22 — which is neither printed on
 * the invoice nor what the card took (€17.57, the market rate plus KBC's
 * margin). Shown beside the payment, it put a second euro figure on the screen
 * that nobody paid.
 *
 * Yuki's XML does not help: measured on 30 pulled documents, UBL came back for
 * 9, all declaring EUR, and for none of the four live foreign invoices. The
 * invoice's own total is only on the PDF, so it is read with the extraction the
 * mailbox path already uses — and this decides whether to believe it.
 */

/** Result of reading an invoice, as far as this decision needs it. */
export type ExtractedInvoice = {
  amount: number | null;
  currency: string | null;
  taxAmount: number | null;
};

/** What the row should become, when it should change at all. */
export type BilledAmountUpdate = {
  amount: number;
  currency: string;
  taxAmount: number | null;
  baseAmount: number;
  baseCurrency: string;
};

export type BilledAmountDecision =
  | { correct: true; update: BilledAmountUpdate }
  | {
      correct: false;
      reason:
        | "no-currency"
        | "same-currency"
        | "no-amount"
        | "no-booked-amount"
        | "no-rate"
        | "implausible";
    };

/**
 * How far the extracted total, converted at today's rate, may sit from the
 * booked amount and still be the same invoice's total.
 *
 * Wide enough for time: only today's rate is stored, and over the last year the
 * dollar moved between 1.12 and 1.17 to the euro, about 4.5%. Narrow enough to
 * catch a misread: the Cursor invoice lists line items of $180.05 and $192.63
 * above its $19.95 total, and either of those lands nearly ten times away.
 */
export const PLAUSIBLE_BAND = 0.15;

/**
 * Whether a pulled row should take the invoice's own currency and total.
 *
 * Only when all of this holds: the extraction read a real currency code, it is
 * not the one the row was booked in, it read a positive total, and that total —
 * converted at the stored rate — agrees with the booked amount to within the
 * band. The booked amount is an independent reading of the same total by the
 * accountant, which is what makes it a check rather than a guess. Anything else
 * leaves Yuki's figures exactly as they are.
 */
export function billedAmountCorrection(params: {
  booked: { amount: number | null; currency: string };
  extracted: ExtractedInvoice;
  /** One unit of the extracted currency, in the booked currency. */
  rateToBooked: number | undefined;
}): BilledAmountDecision {
  const { booked, extracted, rateToBooked } = params;

  const currency = extracted.currency?.trim().toUpperCase() ?? "";
  if (!/^[A-Z]{3}$/.test(currency)) {
    return { correct: false, reason: "no-currency" };
  }

  if (currency === booked.currency) {
    return { correct: false, reason: "same-currency" };
  }

  // Magnitude only: an extraction may read a credit note's total as positive or
  // negative, and the sign is taken from the booked amount below, which knows
  // which one it is.
  const extractedTotal =
    extracted.amount === null ? Number.NaN : Math.abs(extracted.amount);
  if (!Number.isFinite(extractedTotal) || extractedTotal === 0) {
    return { correct: false, reason: "no-amount" };
  }

  if (booked.amount === null || !(Math.abs(booked.amount) > 0)) {
    return { correct: false, reason: "no-booked-amount" };
  }

  if (!rateToBooked || !Number.isFinite(rateToBooked) || rateToBooked <= 0) {
    return { correct: false, reason: "no-rate" };
  }

  const bookedTotal = Math.abs(booked.amount);
  const converted = extractedTotal * rateToBooked;
  if (Math.abs(converted - bookedTotal) / bookedTotal > PLAUSIBLE_BAND) {
    return { correct: false, reason: "implausible" };
  }

  const tax = extracted.taxAmount;

  return {
    correct: true,
    update: {
      // Signed like the booked amount, so a credit note stays a credit note: a
      // -€17.22 booking and a $19.95 extraction become -$19.95, never a positive
      // amount beside a negative base.
      amount: Math.sign(booked.amount) * extractedTotal,
      currency,
      // The invoice's own tax, in the invoice's currency — or none. The booked
      // euro VAT cannot stay on a dollar row, and matching copies a document's
      // tax onto its transaction, so a figure in the wrong currency here would
      // travel.
      taxAmount:
        tax !== null && Number.isFinite(tax)
          ? Math.sign(booked.amount) * Math.abs(tax)
          : null,
      baseAmount: booked.amount,
      baseCurrency: booked.currency,
    },
  };
}
