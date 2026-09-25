import { and, eq, inArray, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Database } from "../client";
import { inbox, transactionMatchSuggestions } from "../schema";
import {
  type InvoiceCopy,
  invoiceIdentity,
  normalizeInvoiceNumber,
  planInvoiceCopies,
} from "../utils/inbox-duplicates";
import { deleteInbox } from "./inbox";

/**
 * An invoice number column as the key copies are compared on: without spaces,
 * upper case. The SQL twin of `normalizeInvoiceNumber`.
 */
export function invoiceNumberKeySql(column: AnyPgColumn | SQL): SQL {
  return sql`upper(regexp_replace(${column}, '\\s+', '', 'g'))`;
}

/** Not deleted. `status` is nullable, and NULL is not deleted. */
const live = or(isNull(inbox.status), ne(inbox.status, "deleted"));

export type ResolveInvoiceCopiesParams = {
  inboxId: string;
  teamId: string;
  /** False reports what would happen and writes nothing. */
  apply: boolean;
};

export type ResolveInvoiceCopiesResult =
  /** The document is not there, or already deleted — by a run that got here first. */
  | { outcome: "gone" }
  /** No other copy of this invoice, or none that may be removed. */
  | { outcome: "unique" }
  | {
      outcome: "resolved";
      keep: string;
      removed: string[];
      /** Whether the document asked about is one of the removed copies. */
      currentRemoved: boolean;
    };

const copyColumns = {
  id: inbox.id,
  invoiceNumber: inbox.invoiceNumber,
  amount: inbox.amount,
  currency: inbox.currency,
  displayName: inbox.displayName,
  type: inbox.type,
  referenceId: inbox.referenceId,
  transactionId: inbox.transactionId,
  createdAt: inbox.createdAt,
  hasConfirmedMatch: sql<boolean>`EXISTS (
    SELECT 1 FROM ${transactionMatchSuggestions}
    WHERE ${transactionMatchSuggestions.inboxId} = ${inbox.id}
      AND ${transactionMatchSuggestions.status} = 'confirmed'
  )`,
};

/**
 * Removes the redundant copies of the invoice an inbox document carries
 * (FF-1549), and says which one it kept.
 *
 * Copies are the team's other live documents with the same supplier, invoice
 * number, amount, currency and type — see `invoiceIdentity`. Which ones go is
 * `planInvoiceCopies`: redundant copies the team received, including one
 * attached to the survivor's payment; never one linked to another payment,
 * never a copy from the books.
 *
 * A removed copy is marked deleted through the inbox's own `deleteInbox`: its
 * attachment comes off the payment and its suggestions go. Its stored file is
 * kept, so a removal can be undone. Documents grouped under it (an invoice's
 * receipt, say) move to the survivor. All of it in one transaction.
 */
export async function resolveInvoiceCopies(
  db: Database,
  params: ResolveInvoiceCopiesParams,
): Promise<ResolveInvoiceCopiesResult> {
  const { inboxId, teamId, apply } = params;

  const [current] = await db
    .select(copyColumns)
    .from(inbox)
    .where(and(eq(inbox.id, inboxId), eq(inbox.teamId, teamId), live))
    .limit(1);

  if (!current) {
    return { outcome: "gone" };
  }

  const identity = invoiceIdentity(current);
  if (!identity) {
    return { outcome: "unique" };
  }

  const rows: InvoiceCopy[] = await db
    .select(copyColumns)
    .from(inbox)
    .where(
      and(
        eq(inbox.teamId, teamId),
        live,
        sql`${invoiceNumberKeySql(inbox.invoiceNumber)} = ${normalizeInvoiceNumber(current.invoiceNumber)}`,
        eq(inbox.amount, current.amount as number),
      ),
    );

  // The query narrows on number and amount; the identity decides.
  const copies = rows.filter((row) => invoiceIdentity(row) === identity);
  if (copies.length < 2) {
    return { outcome: "unique" };
  }

  const plan = planInvoiceCopies(copies);
  if (plan.remove.length === 0) {
    return { outcome: "unique" };
  }

  const removed = plan.remove.map((row) => row.id);

  if (apply) {
    await db.transaction(async (tx) => {
      for (const id of removed) {
        await deleteInbox(tx, { id, teamId });
      }

      // A removed copy may have led a group; its members now follow the survivor.
      await tx
        .update(inbox)
        .set({ groupedInboxId: plan.keep.id })
        .where(
          and(
            eq(inbox.teamId, teamId),
            inArray(inbox.groupedInboxId, removed),
            ne(inbox.id, plan.keep.id),
          ),
        );
      await tx
        .update(inbox)
        .set({ groupedInboxId: null })
        .where(
          and(
            eq(inbox.id, plan.keep.id),
            eq(inbox.teamId, teamId),
            inArray(inbox.groupedInboxId, removed),
          ),
        );
    });
  }

  return {
    outcome: "resolved",
    keep: plan.keep.id,
    removed,
    currentRemoved: removed.includes(inboxId),
  };
}
