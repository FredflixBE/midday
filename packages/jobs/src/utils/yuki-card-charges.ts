import type { BooksStatusEntry } from "@midday/db/queries";
import { YUKI_CARD_HISTORY_DAYS, type YukiCardCharge } from "@midday/yuki";

/**
 * Turning a card charge from the books into an ordinary Midday transaction
 * (FF-1517).
 *
 * The shape on the other side is `upsert-transactions`, the same job every
 * bank provider's transactions go through — so matching, categories, reports
 * and exports need to know nothing about where these came from.
 */

export interface DateWindow {
  from: string;
  to: string;
}

export function cardChargeWindow(
  today: Date,
  historyDays = YUKI_CARD_HISTORY_DAYS,
): DateWindow {
  const from = new Date(today);
  from.setUTCDate(from.getUTCDate() - historyDays);

  // Tomorrow, not today: Yuki dates a booking by the day the charge happened,
  // and `endDate` is compared against that. Asking up to today would be a
  // coin-flip on anything booked with today's date in another timezone.
  const to = new Date(today);
  to.setUTCDate(to.getUTCDate() + 1);

  return { from: isoDate(from), to: isoDate(to) };
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** One transaction as `upsert-transactions` takes it. */
export interface UpsertTransaction {
  id: string;
  name: string;
  description: string | null;
  method: string;
  date: string;
  status: "posted";
  amount: number;
  currency: string;
  balance: number | null;
  category: string | null;
  counterparty_name: string | null;
  merchant_name: string | null;
  original_amount: number | null;
  original_currency: string | null;
  exchange_rate: number | null;
}

/**
 * What a charge in another currency originally cost (FF-1560).
 *
 * The euro amount stays the one the books hold — that is what the card issuer
 * actually took, conversion and fees included. The original is recorded beside
 * it, never instead of it.
 *
 * This used to be flattened into the sentence `USD 18.60 at 1.15` and written
 * into `description`, where nothing could format it to a locale, convert it,
 * put it in an export or match on it — and where it displaced the description.
 *
 * Yuki quotes the rate as units of the original currency per euro, which is the
 * direction the column is defined in, so it is carried through unchanged:
 * 18.60 / 1.1553 is the €16.10 that was charged.
 */
function foreignAmount(charge: YukiCardCharge): {
  original_amount: number | null;
  original_currency: string | null;
  exchange_rate: number | null;
} {
  if (!charge.foreign) {
    return {
      original_amount: null,
      original_currency: null,
      exchange_rate: null,
    };
  }

  const { currency, amount, rate } = charge.foreign;

  // A charge in the administration's own currency is not a conversion, whatever
  // the description said — and the guards on the numbers matter because these
  // are parsed out of Belgian prose, so a shape nobody anticipated arrives as
  // NaN. That was cosmetic while this was a sentence; a numeric column would
  // store it.
  if (currency === charge.currency) {
    return {
      original_amount: null,
      original_currency: null,
      exchange_rate: null,
    };
  }

  return {
    // Always positive: the sign of a charge lives on `amount`, and this is the
    // same money seen from the other currency.
    original_amount: Number.isFinite(amount) ? Math.abs(amount) : null,
    original_currency: currency,
    exchange_rate: Number.isFinite(rate) && rate > 0 ? rate : null,
  };
}

export function toUpsertTransactions(
  charges: readonly YukiCardCharge[],
): UpsertTransaction[] {
  return charges.map((charge) => ({
    // The Yuki ledger line's id, which `upsert-transactions` turns into an
    // internal id scoped to the team. Stable, so a re-run updates nothing and
    // duplicates nothing.
    id: charge.id,
    // The merchant as the card statement wrote it, exactly as a bank would
    // have given it had the bank been willing to share the card at all.
    name: charge.merchant,
    // Null, not Yuki's description — which would defeat the point of FF-1560.
    // That string is the *source* the conversion is parsed out of: it reads
    // `MASTERCARD - Kaartverrichtingen - <merchant> - Vreemde valuta: USD -18,60
    // Wisselkoers: 1,1553 - <merchant>`, so putting it here swaps one
    // restatement of the rate for a longer one in Dutch. Every part of it is
    // already a field: the merchant is `name`, the card boilerplate is `method`,
    // and the conversion is the three columns below. Nothing is left that is a
    // description, so the field is empty — which is what it means.
    description: null,
    method: "card_purchase",
    date: charge.date,
    status: "posted" as const,
    amount: charge.amount,
    currency: charge.currency,
    balance: null,
    category: null,
    // The accountant has usually named the counterparty properly — "Example
    // Inc." where the statement says "EXAMPLE INC NEW YORK NY". That name is
    // what an invoice in the inbox is matched against, so it is worth having.
    counterparty_name: charge.contactName ?? charge.merchant,
    merchant_name: charge.contactName ?? null,
    ...foreignAmount(charge),
  }));
}

export function toBooksStatusEntries(
  charges: readonly YukiCardCharge[],
): BooksStatusEntry[] {
  return charges.map((charge) => ({
    sourceId: charge.id,
    status: charge.status,
    reason: charge.attentionReason,
  }));
}

export interface ChargeCounts {
  total: number;
  invoiceMissing: number;
  inTheBooks: number;
  needsAttention: number;
}

export function countCharges(charges: readonly YukiCardCharge[]): ChargeCounts {
  return {
    total: charges.length,
    invoiceMissing: charges.filter((c) => c.status === "invoice_missing")
      .length,
    inTheBooks: charges.filter((c) => c.status === "in_the_books").length,
    needsAttention: charges.filter((c) => c.status === "needs_attention")
      .length,
  };
}
