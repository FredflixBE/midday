import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Database } from "../client";
import { inbox } from "../schema";
import {
  type InvoiceCopy,
  invoiceIdentity,
  normalizeInvoiceNumber,
  planInvoiceCopies,
} from "../utils/inbox-duplicates";
import { deleteInbox } from "./inbox";

export type ResolveInvoiceCopiesParams = {
  inboxId: string;
  teamId: string;
  /** False reports what would happen and writes nothing. */
  apply: boolean;
};

export type ResolveInvoiceCopiesResult = {
  keep: string;
  removed: string[];
  /** Whether the document asked about is one of the removed copies. */
  currentRemoved: boolean;
} | null;

const copyColumns = {
  id: inbox.id,
  invoiceNumber: inbox.invoiceNumber,
  amount: inbox.amount,
  currency: inbox.currency,
  displayName: inbox.displayName,
  type: inbox.type,
  referenceId: inbox.referenceId,
  transactionId: inbox.transactionId,
  groupedInboxId: inbox.groupedInboxId,
  createdAt: inbox.createdAt,
  hasConfirmedMatch: sql<boolean>`EXISTS (
    SELECT 1 FROM transaction_match_suggestions s
    WHERE s.inbox_id = ${inbox.id} AND s.status = 'confirmed'
  )`,
};

/**
 * Removes the redundant copies of the invoice an inbox document carries
 * (FF-1549), and says which one it kept.
 *
 * Copies are the team's other live documents with the same supplier, invoice
 * number, amount, currency and type — see `invoiceIdentity`. Which ones go is
 * `planInvoiceCopies`: redundant email copies, including one attached to the
 * survivor's payment; never one linked to another payment, never a copy from
 * the books. A removed copy is deleted the way the inbox deletes one — its
 * attachment comes off the payment and its suggestions go — and any document
 * grouped under it (an invoice's receipt, say) moves to the survivor.
 *
 * Returns null when the document has no copies to remove.
 */
export async function resolveInvoiceCopies(
  db: Database,
  params: ResolveInvoiceCopiesParams,
): Promise<ResolveInvoiceCopiesResult> {
  const { inboxId, teamId, apply } = params;

  const [current] = await db
    .select(copyColumns)
    .from(inbox)
    .where(
      and(
        eq(inbox.id, inboxId),
        eq(inbox.teamId, teamId),
        ne(inbox.status, "deleted"),
      ),
    )
    .limit(1);

  const identity = current ? invoiceIdentity(current) : null;
  if (!current || !identity) {
    return null;
  }

  const rows: InvoiceCopy[] = await db
    .select(copyColumns)
    .from(inbox)
    .where(
      and(
        eq(inbox.teamId, teamId),
        ne(inbox.status, "deleted"),
        sql`upper(regexp_replace(${inbox.invoiceNumber}, '\\s+', '', 'g')) = ${normalizeInvoiceNumber(current.invoiceNumber)}`,
        eq(inbox.amount, current.amount as number),
      ),
    );

  // The query narrows on number and amount; the identity decides.
  const copies = rows.filter((row) => invoiceIdentity(row) === identity);
  if (copies.length < 2) {
    return null;
  }

  const plan = planInvoiceCopies(copies);
  if (plan.remove.length === 0) {
    return null;
  }

  const removed = plan.remove.map((row) => row.id);

  if (apply) {
    for (const id of removed) {
      await deleteInbox(db, { id, teamId });
    }

    // A removed copy may have led a group; its members now follow the survivor.
    await db
      .update(inbox)
      .set({ groupedInboxId: plan.keep.id })
      .where(
        and(
          eq(inbox.teamId, teamId),
          inArray(inbox.groupedInboxId, removed),
          ne(inbox.id, plan.keep.id),
        ),
      );
    await db
      .update(inbox)
      .set({ groupedInboxId: null })
      .where(
        and(
          eq(inbox.id, plan.keep.id),
          eq(inbox.teamId, teamId),
          inArray(inbox.groupedInboxId, removed),
        ),
      );
  }

  return {
    keep: plan.keep.id,
    removed,
    currentRemoved: removed.includes(inboxId),
  };
}
