import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm/sql/sql";
import type { Database } from "../client";
import {
  transactionAttachments,
  transactionMatchSuggestions,
  transactions,
} from "../schema";

/**
 * Where a transaction stands on its invoice, as far as **Midday's own records**
 * go (FF-1499).
 *
 * This is one of two answers a transaction carries. The other is
 * `transactions.books_status` — what the accountant's books say — and the two
 * are independent rather than steps on one path: on the live books a payment
 * can be settled by the accountant while Midday holds no document for it, and
 * can have a document in Midday that the accountant has never seen. Anything
 * that collapses them into a single ladder has to render one of those two cells
 * dishonestly, which is why they stay apart all the way to the screen.
 *
 * Derived rather than stored, every time. All three facts it reads — an
 * attachment row, a pending suggestion, the transaction's own status — are
 * Midday's own and cannot drift from themselves. `books_status` is stored
 * precisely because it is *not* Midday's own; see `booksStatusEnum`.
 */
export const INVOICE_STATUSES = [
  "invoice_missing",
  "invoice_pending",
  "invoice_attached",
  "no_invoice_needed",
] as const;

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** A document is filed against this transaction. */
function hasAttachment(teamId: string): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${transactionAttachments}
    WHERE ${transactionAttachments.transactionId} = ${transactions.id}
      AND ${transactionAttachments.teamId} = ${teamId}
  )`;
}

/** The matcher offered a document and nobody has answered yet. */
function hasPendingSuggestion(teamId: string): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${transactionMatchSuggestions}
    WHERE ${transactionMatchSuggestions.transactionId} = ${transactions.id}
      AND ${transactionMatchSuggestions.teamId} = ${teamId}
      AND ${transactionMatchSuggestions.status} = 'pending'
  )`;
}

/**
 * The four values, in precedence order.
 *
 * `completed` is first because it is the only one a person sets by hand, and it
 * is how a bank fee leaves the work list for good. An attachment outranks a
 * suggestion so that a document already filed is never described as something
 * still waiting to be confirmed — 1 transaction on the live books has both.
 */
export function invoiceStatusSql(teamId: string): SQL<InvoiceStatus> {
  return sql<InvoiceStatus>`CASE
    WHEN ${transactions.status} = 'completed' THEN 'no_invoice_needed'
    WHEN ${hasAttachment(teamId)} THEN 'invoice_attached'
    WHEN ${hasPendingSuggestion(teamId)} THEN 'invoice_pending'
    ELSE 'invoice_missing'
  END`;
}

/** Whether a document is filed, on its own — *not* conflated with `completed`. */
export function hasAttachmentSql(teamId: string): SQL<boolean> {
  return sql<boolean>`${hasAttachment(teamId)}`;
}

export function invoiceStatusFilterSql(
  teamId: string,
  statuses: InvoiceStatus[],
): SQL {
  return sql`${invoiceStatusSql(teamId)} IN (${sql.join(
    statuses.map((status) => sql`${status}`),
    sql`, `,
  )})`;
}

/**
 * The transactions that still need a person — the "Missing an invoice" view.
 *
 * Two things leave it out that a naive "no attachment" count would keep:
 *
 * - **Money coming in, and internal transfers.** Neither has a supplier invoice
 *   to find.
 * - **What the books have already settled.** 5 card charges on the live books
 *   are settled by the accountant with no document in Midday. Listing those as
 *   work would be asking for something that is already done, and it is the
 *   single cell that makes inbox zero unreachable if you get it wrong.
 *
 * A *suggestion* the books have settled does stay in, because confirming it is
 * one click and it is Midday's own completeness rather than the accountant's.
 */
export function needsInvoiceSql(teamId: string): SQL {
  return sql`(
    ${transactions.amount} < 0
    AND COALESCE(${transactions.internal}, false) = false
    AND COALESCE(${transactions.status}::text, 'posted') NOT IN ('excluded', 'archived')
    AND (
      ${hasPendingSuggestion(teamId)} AND NOT ${hasAttachment(teamId)}
      OR (
        ${invoiceStatusSql(teamId)} = 'invoice_missing'
        AND ${transactions.booksStatus} IS DISTINCT FROM 'in_the_books'
      )
    )
  )`;
}

export type MissingInvoiceCounts = {
  /** No invoice anywhere. Somebody has to go and find it. */
  missing: number;
  /** A suggestion is waiting. One click. */
  toConfirm: number;
};

/**
 * The headline for the overview, and the reason it is two numbers.
 *
 * "N invoices missing" is one thing to do and "N to confirm" is a different
 * one — a hunt through a supplier portal versus a click — so a single total
 * would overstate the work by however many are already found.
 */
export async function countMissingInvoices(
  db: Database,
  params: { teamId: string },
): Promise<MissingInvoiceCounts> {
  const { teamId } = params;

  const [row] = await db
    .select({
      missing: sql<number>`COUNT(*) FILTER (
        WHERE ${invoiceStatusSql(teamId)} = 'invoice_missing'
      )::int`,
      toConfirm: sql<number>`COUNT(*) FILTER (
        WHERE ${invoiceStatusSql(teamId)} = 'invoice_pending'
      )::int`,
    })
    .from(transactions)
    .where(and(eq(transactions.teamId, teamId), needsInvoiceSql(teamId)));

  return { missing: row?.missing ?? 0, toConfirm: row?.toConfirm ?? 0 };
}
