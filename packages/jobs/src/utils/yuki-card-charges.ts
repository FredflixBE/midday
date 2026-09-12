import type { YukiCardCharge } from "@midday/yuki";

/**
 * Turning a card charge from the books into an ordinary Midday transaction
 * (FF-1517).
 *
 * The shape on the other side is `upsert-transactions`, the same job every
 * bank provider's transactions go through — so matching, categories, reports
 * and exports need to know nothing about where these came from.
 */

/**
 * How far back a run reads the books.
 *
 * Charges reach Yuki with the monthly card statement, two to thirty-six days
 * after the charge itself, so a short window would miss a whole month's worth
 * every time the accountant is slow. A year and a bit covers a full fiscal
 * year plus the lag, costs one call either way, and makes the first sync a
 * complete backfill rather than something a person has to go and ask for.
 */
export const YUKI_CARD_HISTORY_DAYS = 400;

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
}

/**
 * The line that says what a charge in another currency originally cost.
 *
 * The euro amount stays the one the books hold — that is what the card issuer
 * actually took, conversion and fees included. The original is shown beside
 * it, never instead of it.
 */
export function foreignAmountNote(charge: YukiCardCharge): string | null {
  if (!charge.foreign) return null;

  const { currency, amount, rate } = charge.foreign;
  return `${currency} ${Math.abs(amount).toFixed(2)} at ${rate}`;
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
    description: foreignAmountNote(charge),
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
  }));
}

export interface BooksStatusEntry {
  sourceId: string;
  status: YukiCardCharge["status"];
  reason?: string;
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
