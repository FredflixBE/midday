import { and, eq, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm/sql/sql";
import type { Database } from "../client";
import {
  inbox,
  transactionAttachments,
  transactionCategories,
  transactionMatchSuggestions,
  transactions,
} from "../schema";
import { YUKI_INBOX_REFERENCE_PREFIX } from "./yuki-inbox";

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

/**
 * A document is filed against this transaction — on its own, *not* conflated
 * with `completed` the way `isFulfilled` is.
 */
export function hasAttachmentSql(teamId: string): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM ${transactionAttachments}
    WHERE ${transactionAttachments.transactionId} = ${transactions.id}
      AND ${transactionAttachments.teamId} = ${teamId}
  )`;
}

/** The matcher offered a document and nobody has answered yet. */
export function hasPendingSuggestionSql(teamId: string): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM ${transactionMatchSuggestions}
    WHERE ${transactionMatchSuggestions.transactionId} = ${transactions.id}
      AND ${transactionMatchSuggestions.teamId} = ${teamId}
      AND ${transactionMatchSuggestions.status} = 'pending'
  )`;
}

/**
 * What can have a supplier invoice at all.
 *
 * Money coming in has no supplier invoice to find, and neither does a transfer
 * between your own accounts: `internal` catches the pairs Midday recognised,
 * and the category answers for the rest — 4 own-account withdrawals on the live
 * books are in the second group only.
 *
 * ## Why the category is asked rather than named
 *
 * This used to compare the slug against `'transfer'`, one hardcoded name. That
 * left a VAT bill, an owner draw and a card settlement all reading as "Invoice
 * missing" — €28,454 of tax payments on the live books — and every new
 * exception would have been another slug in this expression. The categories now
 * carry the answer themselves (`expects_supplier_invoice`), editable per
 * category, so nothing here needs to know their names.
 *
 * ## Why NOT EXISTS, rather than a join or a lookup
 *
 * The question is only ever *"has a category ruled this out?"*, and phrasing it
 * that way makes the safe default fall out: an uncategorised payment has a NULL
 * slug, nothing has ruled anything out, so it stays work. A join would drop it
 * silently — the same trap `IS DISTINCT FROM` was guarding against here before.
 *
 * This is the **only** place the flag is read. A supplier-level override
 * (FF-1555) belongs here too, as one more reason the answer can be no.
 */
export function isExpenseSql(): SQL<boolean> {
  return sql<boolean>`(
    ${transactions.amount} < 0
    AND COALESCE(${transactions.internal}, false) = false
    AND NOT EXISTS (
      SELECT 1 FROM ${transactionCategories}
      WHERE ${transactionCategories.teamId} = ${transactions.teamId}
        AND ${transactionCategories.slug} = ${transactions.categorySlug}
        AND ${transactionCategories.expectsSupplierInvoice} = false
    )
  )`;
}

/**
 * The four values, in precedence order.
 *
 * **Null for anything that is not an expense.** Money coming in has no supplier
 * invoice, so "Invoice missing" would be a false alarm on every sale. Null means
 * the question does not apply, and the screen shows nothing.
 *
 * A filed document outranks everything: a transaction that has an attachment
 * *and* was marked done by hand is *Invoice attached*, because the document is
 * demonstrably there and "No invoice needed" would contradict it. `completed`
 * answers for the rest, which is how a bank fee leaves the work list for good.
 * A suggestion is last, so a document already filed is never described as one
 * still waiting to be confirmed — 1 transaction on the live books has both.
 */
export function invoiceStatusSql(teamId: string): SQL<InvoiceStatus | null> {
  return sql<InvoiceStatus | null>`CASE
    WHEN NOT ${isExpenseSql()} THEN NULL
    WHEN ${hasAttachmentSql(teamId)} THEN 'invoice_attached'
    WHEN ${transactions.status} = 'completed' THEN 'no_invoice_needed'
    WHEN ${hasPendingSuggestionSql(teamId)} THEN 'invoice_pending'
    ELSE 'invoice_missing'
  END`;
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
 * The inbox's own inbox-zero view: a document exists and nothing has been done
 * with it.
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
    -- Exclude what is known *not* to be an invoice, rather than requiring that
    -- it is one: type is null until a document has been read, so demanding
    -- 'invoice' would hide everything that has only just arrived.
    AND ${inbox.type}::text IS DISTINCT FROM 'other' 
    AND NOT EXISTS (
      SELECT 1 FROM ${inbox} member
      WHERE (member.id = ${inbox.id} OR member.grouped_inbox_id = ${inbox.id})
        AND member.team_id = ${inbox.teamId}
        AND (
          member.transaction_id IS NOT NULL
          OR member.reference_id LIKE ${`${YUKI_INBOX_REFERENCE_PREFIX}%`}
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
