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

/**
 * The `meta` key that records a pulled row's invoice has been read for its
 * billed amount, and what was decided (FF-1572).
 *
 * The read costs an extraction, and most rows come out unchanged — a euro
 * invoice is already right — so "not yet corrected" is not the same as "not yet
 * read". Without this every backfill and every pull over an unfinished row would
 * pay again for the same answer. In `meta` rather than a column because it is a
 * record of work done, not a fact about the invoice.
 */
export const YUKI_BILLED_AMOUNT_READ_KEY = "billedAmountRead";

/** A pulled row, as far as reading its invoice's own total needs it. */
export type YukiInboxRowForBilledAmount = {
  id: string;
  filePath: string[] | null;
  contentType: string | null;
  amount: number | null;
  currency: string | null;
  baseCurrency: string | null;
  /** Whether a read has already reached a decision for this row. */
  alreadyRead: boolean;
};

/**
 * One pulled row, for reading what its invoice actually billed (FF-1572).
 *
 * Narrowed to rows the pull made — `reference_id` starting `yuki:` — because
 * those are the only ones whose amount came from a ledger rather than from the
 * document. A row from a mailbox was read off its PDF already, and reading it
 * again could only disagree with itself.
 */
export async function getYukiInboxRowForBilledAmount(
  db: Database,
  params: { teamId: string; inboxId: string },
): Promise<YukiInboxRowForBilledAmount | null> {
  const [row] = await db
    .select({
      id: inbox.id,
      filePath: inbox.filePath,
      contentType: inbox.contentType,
      amount: inbox.amount,
      currency: inbox.currency,
      baseCurrency: inbox.baseCurrency,
      alreadyRead: sql<boolean>`(${inbox.meta}::jsonb ->> ${YUKI_BILLED_AMOUNT_READ_KEY}) is not null`,
    })
    .from(inbox)
    .where(
      and(
        eq(inbox.id, params.inboxId),
        eq(inbox.teamId, params.teamId),
        sql`${inbox.referenceId} like ${`${YUKI_INBOX_REFERENCE_PREFIX}%`}`,
      ),
    )
    .limit(1);

  return row ?? null;
}

/**
 * Pulled rows whose invoice has not been read for its billed amount yet, oldest
 * first — the set a backfill reads (FF-1572).
 *
 * Both a corrected row (its booked figure in `base_currency`) and a row read and
 * left alone (the marker in `meta`) are left out, which is what makes a second
 * backfill cost nothing. Deleted rows are left out for the reason
 * `getInboxRowsForYukiPull` gives.
 */
export async function getYukiInboxIdsForBilledAmount(
  db: Database,
  params: { teamId: string },
): Promise<string[]> {
  const rows = await db
    .select({ id: inbox.id })
    .from(inbox)
    .where(
      and(
        eq(inbox.teamId, params.teamId),
        sql`${inbox.referenceId} like ${`${YUKI_INBOX_REFERENCE_PREFIX}%`}`,
        isNull(inbox.baseCurrency),
        sql`(${inbox.meta}::jsonb ->> ${YUKI_BILLED_AMOUNT_READ_KEY}) is null`,
        or(isNull(inbox.status), ne(inbox.status, "deleted")),
      ),
    )
    .orderBy(asc(inbox.createdAt), asc(inbox.id));

  return rows.map((row) => row.id);
}

/**
 * Gives a pulled row the currency and total its invoice billed, keeping Yuki's
 * booked figure as the base amount (FF-1572). Returns whether a row changed.
 *
 * Guarded so it can only happen once and only from the state it was read in:
 * the row must still be in the booked currency, with no base currency yet. Two
 * runs over the same row, or a person correcting the amount by hand in between,
 * both leave it alone rather than converting an already-converted figure.
 */
export async function setYukiInboxBilledAmount(
  db: Database,
  params: {
    teamId: string;
    inboxId: string;
    bookedCurrency: string;
    update: {
      amount: number;
      currency: string;
      taxAmount: number | null;
      baseAmount: number;
      baseCurrency: string;
    };
  },
): Promise<boolean> {
  const { teamId, inboxId, bookedCurrency, update } = params;

  const rows = await db
    .update(inbox)
    .set({
      amount: update.amount,
      currency: update.currency,
      taxAmount: update.taxAmount,
      baseAmount: update.baseAmount,
      baseCurrency: update.baseCurrency,
    })
    .where(
      and(
        eq(inbox.id, inboxId),
        eq(inbox.teamId, teamId),
        eq(inbox.currency, bookedCurrency),
        isNull(inbox.baseCurrency),
      ),
    )
    .returning({ id: inbox.id });

  return rows.length > 0;
}

/**
 * Records that a pulled row's invoice was read and what was decided, so it is
 * not read again (FF-1572). Merged into `meta`, never replacing it: `meta` also
 * carries where the row came from and why it last failed.
 */
export async function markYukiBilledAmountRead(
  db: Database,
  params: { teamId: string; inboxId: string; outcome: string },
): Promise<void> {
  await db
    .update(inbox)
    .set({
      meta: sql`(coalesce(${inbox.meta}::jsonb, '{}'::jsonb) || jsonb_build_object(${YUKI_BILLED_AMOUNT_READ_KEY}::text, ${params.outcome}::text))::json`,
    })
    .where(and(eq(inbox.id, params.inboxId), eq(inbox.teamId, params.teamId)));
}
