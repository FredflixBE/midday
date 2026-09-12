import { and, asc, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { Database } from "../client";
import { inbox, transactionMatchSuggestions } from "../schema";

/**
 * The inbox rows that come out of Yuki's archive rather than out of a mailbox
 * (FF-1450).
 *
 * Yuki is the Peppol access point for Belgian B2B, and the accountant also
 * keys in and uploads invoices there directly, so a large part of what the
 * business was billed never reaches Gmail at all — 690 of Yuki's 712 invoice
 * numbers, measured on 2026-09-12. Those documents are pulled into the same
 * inbox as every other one, and from there they behave like any other document:
 * Midday's own matcher attaches them to transactions.
 */

/**
 * The `reference_id` prefix that marks a row as pulled from Yuki's archive.
 *
 * `reference_id` is `UNIQUE` across the table, which is what makes the pull
 * re-runnable: a document already pulled cannot be inserted twice, whatever
 * order the runs happen in. Same shape as `yukiInstitutionId` in `yuki-card.ts`
 * — `yuki:` plus the id Yuki itself uses.
 */
export const YUKI_INBOX_REFERENCE_PREFIX = "yuki:";

/** The `reference_id` for one Yuki archive document. */
export function yukiInboxReference(documentId: string): string {
  return `${YUKI_INBOX_REFERENCE_PREFIX}${documentId}`;
}

/**
 * The Yuki document id behind an inbox row, or null when the row came from
 * somewhere else.
 */
export function yukiDocumentIdFrom(referenceId: string | null): string | null {
  if (!referenceId?.startsWith(YUKI_INBOX_REFERENCE_PREFIX)) return null;
  return referenceId.slice(YUKI_INBOX_REFERENCE_PREFIX.length) || null;
}

export type InboxRowForYukiPull = {
  id: string;
  referenceId: string | null;
  invoiceNumber: string | null;
  groupedInboxId: string | null;
  status: string | null;
  /**
   * Whether Midday's matcher has ever offered this row a transaction.
   *
   * It is here to tell two identical-looking rows apart. A pulled row sits at
   * `pending` both when a run died before closing it and when a person declined
   * the match it was offered — and `declineSuggestedMatch` is what puts it
   * there. Only the second has a suggestion behind it, so this is what stops the
   * next run from re-matching and re-closing a row a person just acted on.
   */
  hasMatchSuggestions: boolean;
};

/**
 * Every inbox row a pull has to know about, of any origin.
 *
 * Deliberately not filtered to `reference_id like 'yuki:%'`, because the pull
 * asks this table two different questions and only one of them is about Yuki's
 * own rows: *which documents have I already pulled?*, and *does Midday already
 * hold this invoice number from somewhere else?* The second is the
 * deduplication, and a query narrowed to Yuki rows would answer it "no" for
 * every invoice that arrived by email — which is exactly the case it exists for.
 *
 * `deleted` rows are left out. Deleting a pulled document is how a person says
 * they did not want it, and returning it here would present it as "not pulled
 * yet" on the next run — the one shape of this job that a person cannot undo by
 * repeating themselves. A row whose status is null is kept: `ne` answers
 * unknown for null, so a bare `ne(status, 'deleted')` would drop it, and a row
 * dropped here is invisible to the deduplication.
 *
 * Ordered oldest first, because the plan built from this picks one row per
 * invoice number and two rows can carry the same one. Unordered, which row that
 * is would be Postgres's choice and could differ between two runs over
 * unchanged data.
 */
export async function getInboxRowsForYukiPull(
  db: Database,
  params: { teamId: string },
): Promise<InboxRowForYukiPull[]> {
  return db
    .select({
      id: inbox.id,
      referenceId: inbox.referenceId,
      invoiceNumber: inbox.invoiceNumber,
      groupedInboxId: inbox.groupedInboxId,
      status: inbox.status,
      hasMatchSuggestions: sql<boolean>`exists (select 1 from ${transactionMatchSuggestions} where ${transactionMatchSuggestions.inboxId} = ${inbox.id})`,
    })
    .from(inbox)
    .where(
      and(
        eq(inbox.teamId, params.teamId),
        or(isNull(inbox.status), ne(inbox.status, "deleted")),
      ),
    )
    .orderBy(asc(inbox.createdAt), asc(inbox.id));
}

export type CreateYukiInboxDocumentParams = {
  teamId: string;
  /** `yuki:<documentID>`; see {@link yukiInboxReference}. */
  referenceId: string;
  filePath: string[];
  fileName: string;
  contentType: string;
  size: number;
  displayName: string;
  amount: number | null;
  currency: string;
  date: string | null;
  taxAmount: number | null;
  invoiceNumber: string | null;
  /**
   * The Midday row this is a second copy of, when the invoice number was
   * already in the inbox. Grouping rather than merging: the existing row keeps
   * whatever match and history it has, and the Yuki copy hangs off it.
   */
  groupedInboxId: string | null;
};

/**
 * Inserts one pulled document, or answers the row that is already there.
 *
 * Everything the document is known to be is written in the one insert, rather
 * than created empty and filled in afterwards. The fields come from Yuki's own
 * archive record — supplier, invoice number, date, total, VAT — which is a
 * better source than reading them back off the PDF, and 690 documents' worth
 * cheaper than asking a model to.
 *
 * The status is `processing` and not the final one: the caller still has to run
 * the matcher over it and mark it done. A run that dies between the two leaves
 * the row exactly as unfinished as it is, and the next run finishes it — see
 * `planYukiPull` in `@midday/jobs`.
 */
export async function createYukiInboxDocument(
  db: Database,
  params: CreateYukiInboxDocumentParams,
): Promise<{ id: string; created: boolean } | null> {
  const [inserted] = await db
    .insert(inbox)
    .values({
      teamId: params.teamId,
      referenceId: params.referenceId,
      filePath: params.filePath,
      fileName: params.fileName,
      contentType: params.contentType,
      size: params.size,
      displayName: params.displayName,
      amount: params.amount,
      currency: params.currency,
      date: params.date,
      taxAmount: params.taxAmount,
      invoiceNumber: params.invoiceNumber,
      groupedInboxId: params.groupedInboxId,
      // Yuki's document type 2 is Aankoopfactuur, and only documents of that
      // type are pulled. The folder says nothing: one of the measured archive's
      // purchase invoices sits in a folder the team made.
      type: "invoice",
      status: "processing",
    })
    // Two runs of the pull racing each other is the case this covers — the
    // second one finds the row rather than failing on the unique index.
    .onConflictDoNothing({ target: inbox.referenceId })
    .returning({ id: inbox.id });

  if (inserted) return { id: inserted.id, created: true };

  const [existing] = await db
    .select({ id: inbox.id })
    .from(inbox)
    .where(
      and(
        eq(inbox.referenceId, params.referenceId),
        eq(inbox.teamId, params.teamId),
      ),
    )
    .limit(1);

  return existing ? { id: existing.id, created: false } : null;
}
