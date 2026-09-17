import {
  DEFAULT_YUKI_PULL_CUTOFF,
  DEFAULT_YUKI_PULL_LIMIT,
} from "@jobs/schemas/yuki";
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
): Map<string, InboxRowForYukiPull> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const byNumber = new Map<string, InboxRowForYukiPull>();

  // Two passes, so the answer does not depend on the order rows arrive in. A
  // row that is nobody's sibling is a group's primary and wins outright; only
  // when a number has no such row does a sibling's `groupedInboxId` stand in.
  // Within each pass the first row wins, and the query orders by creation, so
  // the same inbox produces the same plan twice.
  for (const row of rows) {
    if (row.groupedInboxId !== null) continue;
    const number = comparable(row.invoiceNumber);
    if (number && !byNumber.has(number)) byNumber.set(number, row);
  }

  for (const row of rows) {
    if (row.groupedInboxId === null) continue;
    const number = comparable(row.invoiceNumber);
    if (number && !byNumber.has(number)) {
      // The primary itself when it is listed; otherwise the sibling stands in
      // for what the group says the invoice is, under the primary's id.
      const primary = byId.get(row.groupedInboxId);
      byNumber.set(number, primary ?? { ...row, id: row.groupedInboxId });
    }
  }

  return byNumber;
}

/**
 * References that are carried by more than one invoice, so are not invoice
 * numbers at all (FF-1574).
 *
 * Suppliers put other numbers in the field Yuki calls the reference: KBC
 * Verzekeringen its policy number and its yearly structured payment reference,
 * Xerius the member number. Those recur on invoice after invoice, and the only
 * sign of it that needs no reading of the PDF is the same reference on
 * documents of different dates — across Yuki's purchase invoices, or across
 * inbox rows that are not already one group. A reference seen that way groups
 * nothing, whatever a single pair of documents agrees on.
 *
 * Rows already grouped together count once: they are one invoice, and the mail
 * copy of an invoice routinely carries another date than Yuki's record of it.
 */
function reusedReferences(
  documents: readonly YukiArchiveDocument[],
  rows: readonly InboxRowForYukiPull[],
): Set<string> {
  const datesByNumber = new Map<string, Set<string>>();
  const note = (reference: string | null, date: string | null) => {
    const number = comparable(reference);
    if (!number || !date) return;
    const dates = datesByNumber.get(number) ?? new Set<string>();
    dates.add(date);
    datesByNumber.set(number, dates);
  };

  for (const document of documents) {
    if (document.type !== YUKI_INVOICE_DOCUMENT_TYPES.purchaseInvoice) continue;
    note(document.reference, document.documentDate);
  }

  // One date per group, the primary's where it has one.
  const groupDates = new Map<string, { number: string; date: string }>();
  for (const row of rows) {
    const number = comparable(row.invoiceNumber);
    if (!number || !row.date) continue;
    const group = row.groupedInboxId ?? row.id;
    if (row.groupedInboxId === null || !groupDates.has(group)) {
      groupDates.set(group, { number, date: row.date });
    }
  }

  const inboxDatesByNumber = new Map<string, Set<string>>();
  for (const { number, date } of groupDates.values()) {
    const dates = inboxDatesByNumber.get(number) ?? new Set<string>();
    dates.add(date);
    inboxDatesByNumber.set(number, dates);
  }

  const reused = new Set<string>();
  for (const map of [datesByNumber, inboxDatesByNumber]) {
    for (const [number, dates] of map) {
      if (dates.size > 1) reused.add(number);
    }
  }
  return reused;
}

/**
 * Whether the totals of a Yuki document and an inbox row say they are two
 * different invoices.
 *
 * This only ever refuses. The epic's rule is that amounts and dates never
 * decide a match on their own, and they do not here: two documents are still
 * grouped only on an invoice number. A number that agrees while the totals do
 * not is the reused reference of FF-1574, and grouping on it is the damage.
 *
 * Yuki's archive total is the euro it booked, so a row in another currency, or
 * either side without a total, cannot refuse anything.
 */
function totalsDisagree(
  document: YukiArchiveDocument,
  row: InboxRowForYukiPull,
): boolean {
  if (row.amount === null || row.currency !== "EUR") return false;
  if (!document.amount) return false;
  const booked = Number(document.amount);
  if (!Number.isFinite(booked)) return false;
  return Math.round(booked * 100) !== Math.round(row.amount * 100);
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
  const reused = reusedReferences(archive.documents, inboxRows);

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
    const row = number && !reused.has(number) ? byNumber.get(number) : null;
    return {
      document,
      groupWith: row && !totalsDisagree(document, row) ? row.id : null,
    };
  });

  counts.duplicates = pull.filter((c) => c.groupWith !== null).length;
  counts.remaining = counts.eligible - pull.length;

  return { pull, finish, counts };
}
