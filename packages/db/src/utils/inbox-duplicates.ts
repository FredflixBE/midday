/**
 * When two inbox documents are one invoice, and which of them to keep.
 *
 * Email ingestion refuses a second copy of the same *file* (the reference is a
 * hash of the bytes), but suppliers defeat that: Google and Adobe send every
 * invoice to both of a team's connected mailboxes, and each recipient gets a
 * separately generated PDF. Same invoice number, same amount, different bytes,
 * so both were stored and each got its own match suggestion (FF-1549).
 *
 * This module decides on what the documents say instead. It is pure so that
 * ingestion and the one-off cleanup make the same decision, and so that two
 * copies processed at the same moment agree on which one survives.
 */

import { YUKI_INBOX_REFERENCE_PREFIX } from "../queries/yuki-inbox";

export type InvoiceCopy = {
  id: string;
  invoiceNumber: string | null;
  amount: number | null;
  currency: string | null;
  displayName: string | null;
  type: "invoice" | "expense" | "other" | null;
  referenceId: string | null;
  transactionId: string | null;
  hasConfirmedMatch: boolean;
  createdAt: string;
};

type IdentityFields = Pick<
  InvoiceCopy,
  "invoiceNumber" | "amount" | "currency" | "displayName" | "type"
>;

/**
 * An invoice number as printed, minus the spacing and case that vary by PDF.
 * `invoiceNumberKeySql` in queries/inbox-duplicates.ts is the same in SQL.
 */
export function normalizeInvoiceNumber(value: string | null): string | null {
  const normalized = value?.replace(/[ \t\n\r\f\v]+/g, "").toUpperCase() ?? "";
  return normalized === "" ? null : normalized;
}

/**
 * The key two copies of one invoice share: supplier, number, amount, currency
 * and document type. `null` when any part is missing, because a document that
 * cannot be told apart from another must never be removed as its copy.
 *
 * The type is part of it on purpose: an invoice and its own receipt carry one
 * number and are grouped, not duplicates of each other.
 */
export function invoiceIdentity(row: IdentityFields): string | null {
  const number = normalizeInvoiceNumber(row.invoiceNumber);
  const supplier = row.displayName?.trim().toLowerCase();
  const currency = row.currency?.trim().toUpperCase();
  if (!number || !supplier || !currency || row.amount === null || !row.type) {
    return null;
  }
  return [
    supplier,
    number,
    Number(row.amount).toFixed(2),
    currency,
    row.type,
  ].join("|");
}

/** A copy the pull made from the books. The books' own record: never removed. */
export function isBooksCopy(row: Pick<InvoiceCopy, "referenceId">): boolean {
  return row.referenceId?.startsWith(YUKI_INBOX_REFERENCE_PREFIX) ?? false;
}

function isInUse(row: InvoiceCopy): boolean {
  return row.transactionId !== null || row.hasConfirmedMatch;
}

/** Earlier wins; the id breaks a tie, so every caller orders them alike. */
function byAge(a: InvoiceCopy, b: InvoiceCopy): number {
  const time =
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  return time !== 0 ? time : a.id.localeCompare(b.id);
}

/**
 * Of one invoice's copies, the one to keep and the ones to remove.
 *
 * Only copies the team received itself are ever removed, never a copy from the
 * books. One of them always survives: the one with a confirmed match (so the
 * match history that auto-matching learns from keeps its record), else one
 * linked to a payment, else the oldest.
 *
 * A copy in use is redundant only when it is in use for the same payment as
 * the survivor: both mailboxes' PDFs confirmed onto one payment put the
 * invoice on it twice. A copy linked to a different payment is a question for
 * a person, not for this rule, so it stays.
 *
 * Deterministic in its input and nothing else — not the order, not how the
 * inbox happens to group the copies right now — so two copies processed at
 * once each run this over the same rows and reach the same answer.
 */
export function planInvoiceCopies(copies: InvoiceCopy[]): {
  keep: InvoiceCopy;
  remove: InvoiceCopy[];
} {
  const sorted = [...copies].sort(byAge);
  const received = sorted.filter((row) => !isBooksCopy(row));
  const candidates = received.length > 0 ? received : sorted;

  const keep =
    candidates.find((row) => row.hasConfirmedMatch) ??
    candidates.find((row) => row.transactionId !== null) ??
    candidates[0];

  if (!keep) {
    throw new Error("planInvoiceCopies needs at least one copy");
  }

  const remove = received.filter(
    (row) =>
      row.id !== keep.id &&
      (!isInUse(row) ||
        (keep.transactionId !== null &&
          row.transactionId === keep.transactionId)),
  );

  return { keep, remove };
}
