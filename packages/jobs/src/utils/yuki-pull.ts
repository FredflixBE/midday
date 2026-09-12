import {
  type InboxRowForYukiPull,
  yukiDocumentIdFrom,
} from "@midday/db/queries";
import { comparableInvoiceReference } from "@midday/utils/invoice-reference";
import type { YukiArchive, YukiArchiveDocument } from "@midday/yuki/archive";
import { YUKI_INVOICE_DOCUMENT_TYPES } from "@midday/yuki/archive";
import { MINIMUM_COMPARABLE_REFERENCE_LENGTH } from "@midday/yuki/decide";

/**
 * Which of Yuki's purchase invoices Midday should pull into its inbox
 * (FF-1450), worked out from an archive already read and an inbox already
 * listed.
 *
 * Pure: no database, no Yuki session, no storage. Everything that decides what
 * a run does is here, and the task around it does the fetching and the writing.
 *
 * **The title of the ticket undersells what this covers.** It is not only the
 * invoices that arrived over Peppol — it is every purchase invoice Yuki holds
 * and Midday does not, whether the accountant keyed it in, the supplier sent it
 * to the Postbus, or Peppol delivered it. Measured on the live books on
 * 2026-09-12: Midday held 22 of Yuki's 712 invoice numbers, and the other 690
 * existed only in Yuki. Those 690 are why Midday counts 284 transactions as
 * "invoice missing" while Yuki is waiting on 81.
 */

/**
 * How far back a pull reaches, by invoice date.
 *
 * The archive goes back five years; Midday's transactions go back one
 * (2025-08-08 at the time of writing). 404 of the 696 missing invoices predate
 * any transaction Midday will ever hold, so pulling them would put documents in
 * the inbox that can never match anything — noise in every count this epic is
 * trying to make honest.
 *
 * 2025-01-01 rather than the transaction window's own start, because an invoice
 * is often paid months after its date, and rather than "the last 13 months",
 * because whole fiscal years are how the books are closed and how an accountant
 * reads them. It is a parameter rather than a constant because the useful
 * cutoff moves: an Enable Banking backfill or more card history (FF-1517) both
 * widen Midday's window, and widening this is then a re-run rather than a code
 * change — the reference id makes re-running fetch only what is new.
 */
export const DEFAULT_YUKI_PULL_CUTOFF = "2025-01-01";

/**
 * How many documents one run pulls.
 *
 * The first run has a backlog of roughly 290 documents, each a SOAP call, a
 * decode and a file into storage, and the task has ten minutes. Draining it
 * over a few days costs nothing — the pull is keyed on the Yuki document id, so
 * every run picks up where the last one stopped — and a bounded run is also
 * what keeps a first live run from being the largest thing this integration has
 * ever done.
 */
export const DEFAULT_YUKI_PULL_LIMIT = 50;

/**
 * Whether a row this job pulled earlier was left unfinished by a run that
 * stopped part way.
 *
 * Pulling is three steps — insert the row, run the matcher, mark it done — and
 * a run that dies between them leaves a row no later run would look at again,
 * because its Yuki document id is taken. So those rows are picked up and
 * finished rather than left in the inbox looking like work the accountant has
 * in fact already done.
 *
 * `processing` is a row whose matcher never started, `analyzing` one whose
 * matcher was in flight.
 *
 * `pending` is the delicate one, because two different things put a row there:
 * the matcher finding nothing, and a person declining the match it offered
 * (`declineSuggestedMatch`). Only the second leaves a suggestion behind, which
 * is what separates them — without that test this job would re-match and
 * re-close, every day, a row somebody had just acted on.
 *
 * The statuses a person moves a row to deliberately — archived, deleted, done —
 * and `suggested_match`, where a real suggestion is waiting for an answer, are
 * all left alone.
 */
function isUnfinishedPull(row: InboxRowForYukiPull): boolean {
  if (row.status === "processing" || row.status === "analyzing") return true;
  return row.status === "pending" && !row.hasMatchSuggestions;
}

export interface YukiPullCandidate {
  document: YukiArchiveDocument;
  /**
   * The inbox row this document is a second copy of, or null.
   *
   * Set when Midday already holds this invoice number — the same invoice
   * reaching Midday by email and by this pull. The existing row is left exactly
   * as it is, because it already carries whatever match and history Midday has
   * built on it; the Yuki copy is inserted pointing at it, so the two show as
   * one document with two files rather than as two invoices.
   */
  groupWith: string | null;
}

export interface YukiPullPlan {
  /** What to fetch and insert this run, newest invoice first. */
  pull: YukiPullCandidate[];
  /** Inbox ids of documents pulled by an earlier run that never finished. */
  finish: string[];
  counts: {
    /** Purchase invoices in the archive, across every folder. */
    purchaseInvoices: number;
    /** Skipped: older than the cutoff. */
    beforeCutoff: number;
    /** Skipped: Yuki gave no document date, so nothing relates it to a payment. */
    undated: number;
    /** Skipped: Midday already has a row for this Yuki document. */
    alreadyPulled: number;
    /** Of {@link pull}, how many are a second copy of a document Midday has. */
    duplicates: number;
    /** Everything that could be pulled, before the run's limit. */
    eligible: number;
    /** Eligible documents this run is leaving for the next one. */
    remaining: number;
  };
}

/**
 * A comparable invoice number, or null when there is nothing usable to compare.
 *
 * The same function and the same floor FF-1493 uses (`comparableInvoiceReference`
 * plus {@link MINIMUM_COMPARABLE_REFERENCE_LENGTH}), because a second
 * normaliser that drifted from the first would show up here as a duplicate
 * inbox row and nowhere else. Below the floor nothing is decided either way:
 * the document is still pulled, it is simply not grouped with anything.
 */
function comparable(reference: string | null): string | null {
  if (!reference) return null;
  const normalized = comparableInvoiceReference(reference);
  if (!normalized || normalized.length < MINIMUM_COMPARABLE_REFERENCE_LENGTH) {
    return null;
  }
  return normalized;
}

/**
 * The row a Yuki copy of an invoice number should hang off, by number.
 *
 * When a number is on several rows already, the group's primary wins — that is
 * the row Midday's own grouping picked, and pointing at a member of a group
 * instead would make a chain nothing renders.
 */
function inboxRowsByInvoiceNumber(
  rows: readonly InboxRowForYukiPull[],
): Map<string, string> {
  const byNumber = new Map<string, string>();

  // Two passes, so the answer does not depend on the order rows arrive in. A
  // row that is nobody's sibling is a group's primary and wins outright; only
  // when a number has no such row does a sibling's `groupedInboxId` stand in.
  // Within each pass the first row wins, and the query orders by creation, so
  // the same inbox produces the same plan twice.
  for (const row of rows) {
    if (row.groupedInboxId !== null) continue;
    const number = comparable(row.invoiceNumber);
    if (number && !byNumber.has(number)) byNumber.set(number, row.id);
  }

  for (const row of rows) {
    if (row.groupedInboxId === null) continue;
    const number = comparable(row.invoiceNumber);
    if (number && !byNumber.has(number)) {
      byNumber.set(number, row.groupedInboxId);
    }
  }

  return byNumber;
}

export function planYukiPull(params: {
  archive: Pick<YukiArchive, "documents">;
  inboxRows: readonly InboxRowForYukiPull[];
  /** `YYYY-MM-DD`; invoices dated before this are left in Yuki. */
  cutoff?: string;
  limit?: number;
}): YukiPullPlan {
  const {
    archive,
    inboxRows,
    cutoff = DEFAULT_YUKI_PULL_CUTOFF,
    limit = DEFAULT_YUKI_PULL_LIMIT,
  } = params;

  const pulledDocumentIds = new Map<string, InboxRowForYukiPull>();
  for (const row of inboxRows) {
    const documentId = yukiDocumentIdFrom(row.referenceId);
    if (documentId) pulledDocumentIds.set(documentId, row);
  }

  const byNumber = inboxRowsByInvoiceNumber(inboxRows);

  const counts = {
    purchaseInvoices: 0,
    beforeCutoff: 0,
    undated: 0,
    alreadyPulled: 0,
    duplicates: 0,
    eligible: 0,
    remaining: 0,
  };

  const finish: string[] = [];
  const eligible: YukiArchiveDocument[] = [];

  for (const document of archive.documents) {
    // By type, across every folder. Only types 2 and 6 are invoices, and 106
    // documents of the measured archive carry a reference without being one —
    // a bank statement, a VAT return, a journal entry. One purchase invoice sat
    // in a folder the team made rather than in Aankoop, which is why this does
    // not filter by folder.
    if (document.type !== YUKI_INVOICE_DOCUMENT_TYPES.purchaseInvoice) continue;
    counts.purchaseInvoices += 1;

    const already = pulledDocumentIds.get(document.documentId);
    if (already) {
      counts.alreadyPulled += 1;
      if (isUnfinishedPull(already)) finish.push(already.id);
      continue;
    }

    if (!document.documentDate) {
      counts.undated += 1;
      continue;
    }

    if (document.documentDate < cutoff) {
      counts.beforeCutoff += 1;
      continue;
    }

    eligible.push(document);
  }

  counts.eligible = eligible.length;

  // Newest first: a recent invoice is the one whose transaction Midday already
  // holds, and the one a person is most likely to be looking for.
  eligible.sort((a, b) =>
    (b.documentDate ?? "").localeCompare(a.documentDate ?? ""),
  );

  const pull = eligible.slice(0, Math.max(0, limit)).map((document) => {
    const number = comparable(document.reference);
    return {
      document,
      groupWith: number ? (byNumber.get(number) ?? null) : null,
    };
  });

  counts.duplicates = pull.filter((c) => c.groupWith !== null).length;
  counts.remaining = counts.eligible - pull.length;

  return { pull, finish, counts };
}
