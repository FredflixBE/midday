/**
 * What the inbox calls a document.
 *
 * `inbox.type` is `invoice | expense | other`, and `expense` has always been
 * the word for a receipt: `findRelatedInboxItems` pairs an invoice with an
 * *expense* of the same supplier, amount and date, which only reads as sensible
 * if the expense is the invoice's own receipt.
 *
 * Nothing ever produced that word for a PDF, though. `type` was decided by
 * which processor ran, and the processor is picked from the mimetype — so every
 * PDF came out `invoice` and every photo came out `expense`. The field said
 * what the *file* was, not what the *document* was, and a supplier who mails an
 * invoice and its receipt as two PDFs put two `invoice` rows in the inbox
 * carrying one invoice number. 62 of them, in 32 reciprocal pairs (FF-1533).
 *
 * The extraction has known the difference all along: `document_type` is
 * `invoice | receipt | other` on both schemas and was read only to spot
 * `other`. This turns it into the answer, with the file name read first
 * wherever the supplier put the word in it.
 */

/** The three words `inbox.type` can hold. */
export type InboxType = "invoice" | "expense" | "other";

/** What the extraction says a document is. */
export type ExtractedDocumentType = "invoice" | "receipt" | "other";

/**
 * Words that name a document in a file name, in the languages this inbox
 * receives — English, Dutch and French.
 *
 * Matched as substrings, so a Dutch compound (`aankoopfactuur`) still reads.
 * That is also why the short words are missing: the French `reçu` is a
 * substring of `recurring` and of `recuperation`, and a file named
 * `recurring-charges.pdf` is not a receipt. A word earns its place here only if
 * finding it inside a longer word is still the right answer.
 */
const RECEIPT_WORDS = [
  "receipt",
  "kassaticket",
  "kasticket",
  "kwitantie",
  "ontvangstbewijs",
  "betaalbewijs",
  "betalingsbewijs",
  "quittance",
] as const;

const INVOICE_WORDS = [
  "invoice",
  "factuur",
  "facture",
  "rechnung",
  "faktura",
] as const;

function normalise(fileName: string): string {
  return fileName.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * What the file name says the document is, or `null` when it does not say.
 *
 * A name carrying both words says nothing: `invoice-and-receipt.pdf` is a
 * question for a person, not an answer.
 */
export function inboxTypeFromFileName(
  fileName: string | null | undefined,
): "invoice" | "expense" | null {
  if (!fileName) {
    return null;
  }

  const name = normalise(fileName);
  const saysReceipt = RECEIPT_WORDS.some((word) => name.includes(word));
  const saysInvoice = INVOICE_WORDS.some((word) => name.includes(word));

  if (saysReceipt === saysInvoice) {
    return null;
  }

  return saysReceipt ? "expense" : "invoice";
}

export type ResolveInboxTypeParams = {
  /** `document_type` as extracted, when the extraction produced one. */
  documentType?: ExtractedDocumentType | null;
  /** The file as it arrived, name included. */
  fileName?: string | null;
  /**
   * The processor's own answer — `"invoice"` for a PDF, `"expense"` for a
   * photo, because the processor is chosen from the mimetype.
   *
   * Used only when neither the extraction nor the file name says anything, so
   * that a document with no signal at all keeps the type it has always been
   * given rather than losing one. Taken loosely typed and narrowed here, so the
   * three ingestion paths do not each have to spell the narrowing out.
   */
  fallback?: string | null;
};

/**
 * The type to store for an extracted document.
 *
 * **`other` first, because it is the one answer that is never a default.** Both
 * merge functions in `utils/validation.ts` fill an absent `document_type` in —
 * `mergeExtractionResults` with `"invoice"`, `mergeReceiptExtractionResults`
 * with `"receipt"` — so either of those two can be a judgement the model made
 * or a blank the merge filled, and from here they are indistinguishable.
 * Neither ever defaults to `"other"`.
 *
 * **Then the file name**, where it says one thing and not the other. A supplier
 * who writes `Receipt-2179-6847-3809.pdf` is labelling the document, and that
 * label is worth more than a field that might have been filled in for it. This
 * is the reading a person does at a glance, 32 times, which is what FF-1533 is
 * about.
 *
 * **Then the extraction**, which is right far more often than not and is all
 * there is for a file named `5474979359.pdf`.
 */
export function resolveInboxType({
  documentType,
  fileName,
  fallback,
}: ResolveInboxTypeParams): InboxType {
  if (documentType === "other") {
    return "other";
  }

  const fromFileName = inboxTypeFromFileName(fileName);

  if (fromFileName) {
    return fromFileName;
  }

  if (documentType === "invoice" || documentType === "receipt") {
    return documentType === "receipt" ? "expense" : "invoice";
  }

  return fallback === "expense" ? "expense" : "invoice";
}
