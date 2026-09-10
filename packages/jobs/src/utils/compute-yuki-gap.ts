import type { Database } from "@midday/db/client";
import { getInboxDocumentsForYukiGap } from "@midday/db/queries";
import { fetchOutstandingCreditorItems, type YukiClient } from "@midday/yuki";
import { addDays, format, parseISO } from "date-fns";
import { reconcileYukiGap, type YukiGapReport } from "./yuki-gap";

/**
 * Belgian and Dutch Yuki domains keep their books in euros, and the payments
 * Yuki reports carry no currency of their own. Matching a foreign-currency
 * invoice relies on the Midday team's base currency being euros as well, since
 * that is what the inbox converts to.
 */
export const YUKI_BOOK_CURRENCY = "EUR";

/**
 * How far from a payment a document can sit and still be rated plausible by
 * Midday's date scorer: an invoice paid up to ~123 days after it was issued,
 * a receipt dated up to ~93 days after the charge. The query window is cut
 * there, so it never hides a document the scorer could have matched.
 */
const DOCUMENT_WINDOW_BEFORE_DAYS = 125;
const DOCUMENT_WINDOW_AFTER_DAYS = 95;

const shift = (date: string, days: number) =>
  format(addDays(parseISO(date), days), "yyyy-MM-dd");

/**
 * Asks Yuki what it is missing, then asks Midday's inbox whether it has it.
 * Reads only: nothing is written to either side.
 */
export async function computeYukiGap(params: {
  db: Database;
  client: YukiClient;
  teamId: string;
}): Promise<YukiGapReport> {
  const { db, client, teamId } = params;

  const items = await fetchOutstandingCreditorItems(client);
  const dates = items
    .filter((i) => i.kind === "payment_awaiting_invoice")
    .map((i) => i.date)
    .sort();

  const first = dates[0];
  const last = dates[dates.length - 1];
  const documents =
    first && last
      ? await getInboxDocumentsForYukiGap(db, {
          teamId,
          from: shift(first, -DOCUMENT_WINDOW_BEFORE_DAYS),
          to: shift(last, DOCUMENT_WINDOW_AFTER_DAYS),
        })
      : [];

  return reconcileYukiGap({
    items,
    documents,
    bookCurrency: YUKI_BOOK_CURRENCY,
  });
}
