import { and, eq, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm/sql/sql";
import type { Database } from "../client";
import {
  inbox,
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

/**
 * The other half of the same question, on the inbox side: a document exists and
 * nothing has been done with it.
 *
 * It lives beside the transaction view deliberately. The rule that makes both
 * lists reach zero is that **each piece of work appears on exactly one of
 * them** — the transactions view owns finding and confirming, this one owns
 * filing and sending — and a rule split across two files is a rule that drifts.
 *
 * ## Why "no transaction" is not the test
 *
 * A document with no transaction is not necessarily unfinished. Three reasons
 * it can be legitimately done, measured on the live inbox:
 *
 * - **It came from the books** (78). The accountant has it and has booked it.
 * - **It charges nothing** (21). No payment was ever going to appear.
 * - **It is not an invoice** (32).
 *
 * ## Judge the group, not the row
 *
 * When the pull found an invoice Midday already held, it filed the copy against
 * the original via `grouped_inbox_id`. So the finishing facts are checked across
 * every member of the group: today 4 rows sit at `pending`, `suggested_match`
 * or `analyzing` whose twin in the same group is already booked, and reading
 * rows one at a time shows all four as work that does not exist.
 */
export function inboxNeedsHandlingSql(): SQL {
  return sql`(
    ${inbox.status}::text NOT IN ('done', 'deleted', 'archived', 'no_charge', 'other')
    AND (${inbox.type}::text = 'invoice' OR ${inbox.status}::text = 'failed')
    AND NOT EXISTS (
      SELECT 1 FROM ${inbox} member
      WHERE (member.id = ${inbox.id} OR member.grouped_inbox_id = ${inbox.id})
        AND member.team_id = ${inbox.teamId}
        AND (
          member.transaction_id IS NOT NULL
          OR member.reference_id LIKE 'yuki:%'
        )
    )
  )`;
}

/** How much is left in the inbox's "Needs handling" view. */
export async function countInboxNeedsHandling(
  db: Database,
  params: { teamId: string },
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(inbox)
    .where(
      and(
        eq(inbox.teamId, params.teamId),
        // The list only ever renders a group's primary row, so the count has to
        // agree with it or the tab promises work the list cannot show.
        isNull(inbox.groupedInboxId),
        inboxNeedsHandlingSql(),
      ),
    );

  return row?.count ?? 0;
}
