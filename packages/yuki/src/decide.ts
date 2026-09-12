import { comparableInvoiceReference } from "@midday/utils/invoice-reference";
import type { YukiArchive, YukiArchiveDocument } from "./archive";

/**
 * What Midday should do with each of its own documents, on the purchase side
 * (FF-1493).
 *
 * ## The principle
 *
 * **Every decision here is made on an identifier one system created and the
 * other stores**: an invoice number found in the document's own text, a Yuki
 * document id, or a Yuki document type. **Amounts and dates never decide.**
 *
 * That is not a style preference, it is what the first design got wrong. It
 * started from Yuki's list of payments with no invoice and tried to find the
 * invoice belonging to each payment. A payment carries no invoice number — only
 * a date, an amount and a merchant name — so the pairing had to compare amounts
 * and dates, and both are unusable: a $20 invoice is €17.21 in Yuki and €17.19
 * in Midday, two correct conversions at different rates; the same invoice was
 * dated 7 and 14 days apart in the two systems. It would have uploaded a $20
 * invoice against a €20 charge.
 *
 * The pairing was never Midday's to do either. Yuki's own matcher links an
 * invoice to its payment. Midday's job stops at *delivering the document*.
 *
 * ## Why it prefers to stop
 *
 * The two mistakes are not symmetrical. **Yuki has no delete operation**, so
 * delivering a document Yuki already holds is a permanent duplicate in live
 * books. Failing to deliver one is visible and recoverable: the payment stays on
 * Yuki's outstanding list, which is the scoreboard this integration reads.
 *
 * So wherever an identifier does not decide, this does not guess — the document
 * goes to **Needs attention** with the reason, and a human looks at it once.
 */

/**
 * The shortest invoice number that can be acted on, in comparable characters.
 *
 * The shortest real number in the measured Yuki archive (778 invoices,
 * 2026-09-12) normalises to four characters, so four is the floor rather than a
 * round number picked for comfort.
 *
 * Below it, neither half of the test means anything. A three-character string
 * appears by accident in almost any PDF text layer, so {@link rule 1}'s check
 * that the number is really in the document stops being evidence; and a
 * three-character lookup against the archive is as likely to hit someone else's
 * number as the right one. The dangerous outcome is the quiet one: a number
 * that short which *misses* in the archive reads as "Yuki does not have this",
 * and the invoice gets delivered a second time under a number nobody verified.
 */
export const MINIMUM_COMPARABLE_REFERENCE_LENGTH = 4;

/** What to do with a document. */
export type YukiDeliveryAction =
  /** Yuki does not have it and every check passed — FF-1458 delivers it. */
  | "send"
  /** Yuki already holds it as an invoice. Nothing to do. */
  | "in_yuki"
  /** No identifier settled it. A human decides — FF-1499 shows these. */
  | "needs_attention"
  /** Out of scope, or already in flight. Nothing to do on this run. */
  | "not_applicable";

/**
 * Why a document needs a human.
 *
 * These are the codes FF-1499's statuses are built from, so each one is a
 * distinct thing a person would do about it, not a severity.
 */
export type YukiAttentionReason =
  /** Rule 1 — Midday extracted no invoice number at all. */
  | "no_invoice_number"
  /** Rule 1 — the number has no letter or digit in it, so nothing compares. */
  | "invoice_number_unusable"
  /** Rule 1 — shorter than {@link MINIMUM_COMPARABLE_REFERENCE_LENGTH}. */
  | "invoice_number_too_short"
  /** Rule 1 — the file has no text layer, so the number cannot be verified. */
  | "no_text_layer"
  /** Rule 1 — the number is not in the document it was supposedly read from. */
  | "invoice_number_not_in_document"
  /** Rule 2 — another Midday document carries the same number. */
  | "shared_invoice_number"
  /** Rule 3½ — Yuki holds this number, but not on an invoice yet. */
  | "in_yuki_unclassified"
  /** Rule 5 — delivered, and Yuki still has not booked it. */
  | "not_booked_after_delivery";

/** Why there is nothing to decide. */
export type YukiNotApplicableReason =
  /** Midday classified it as not a financial document. */
  | "not_an_invoice"
  /** Extraction has not finished, so there is no number to work from. */
  | "not_extracted"
  /** Delivered, and still inside the window Yuki is allowed to take. */
  | "awaiting_yuki";

/**
 * One of Midday's documents, as this decision needs to see it.
 *
 * Everything here is either an identifier or the text an identifier is verified
 * against. There is deliberately no amount and no date: a field that is present
 * is a field that gets used, and those two are exactly the ones that must not
 * be. FF-1499 reads them from the inbox row for display.
 */
export interface YukiDeliveryCandidate {
  /** The inbox row id. Only ever passed through, never compared. */
  id: string;
  /** The invoice number Midday extracted, exactly as extracted. */
  invoiceNumber: string | null;
  /** Midday's classification. `other` is out of scope; null means unfinished. */
  type: "invoice" | "expense" | "other" | null;
  /**
   * The document's own text layer, or **null when there is none** — a scan, an
   * image, or a PDF whose text could not be read.
   *
   * Null and empty are the same answer here and both mean *cannot verify*,
   * which is why this is not optional: a caller that has not tried to extract
   * the text has to say so rather than let the field default to absent and get
   * a confident answer built on nothing.
   */
  documentText: string | null;
  /**
   * True when the number came from structured data rather than from reading the
   * page — a Peppol/UBL document, where the number *is* a field.
   *
   * This skips rule 1's text check, because there is no text layer to check it
   * against and the number is not an OCR guess in the first place.
   */
  structured?: boolean;
  /**
   * When this document was delivered to Yuki, if it has been (FF-1458), as
   * `YYYY-MM-DD`. Absent means never delivered.
   *
   * A delivered document must never come back as `send` — that is the one
   * output that cannot be undone — so this is checked before anything else.
   */
  deliveredOn?: string | null;
}

/** The decision for one document, with everything a human would want to see. */
export interface YukiDeliveryDecision {
  /** The candidate's {@link YukiDeliveryCandidate.id}. */
  id: string;
  action: YukiDeliveryAction;
  /** Set on `needs_attention` and `not_applicable`, absent on the other two. */
  reason?: YukiAttentionReason | YukiNotApplicableReason;
  /** The comparable form the decision was made on, when there was one. */
  comparableReference: string | null;
  /**
   * Every Yuki document carrying this number, on `in_yuki` and on
   * `in_yuki_unclassified`.
   *
   * A list rather than one id because a number genuinely sits on more than one
   * document sometimes — four did in the measured archive, each time on
   * documents of the same contact, so a repeat rather than a collision. Which
   * of them is *the* invoice is a judgement, and this does not make it.
   */
  yukiDocuments: readonly YukiArchiveDocument[];
  /**
   * The other Midday documents sharing this number, on `shared_invoice_number`.
   */
  sharedWith: readonly string[];
}

/**
 * How long Yuki may take to book a delivered document before it is worth
 * looking at. Days.
 */
export const DEFAULT_BOOKING_GRACE_DAYS = 7;

const MILLISECONDS_PER_DAY = 86_400_000;

function daysBetween(from: string, to: Date): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  if (Number.isNaN(start)) return 0;
  return Math.floor((to.getTime() - start) / MILLISECONDS_PER_DAY);
}

/**
 * Decides, for a whole set of Midday's documents at once, which ones Yuki is
 * missing.
 *
 * **The set is the unit, not the document.** Rule 2 asks whether two of
 * Midday's own documents carry the same invoice number — an invoice and its
 * billing statement, say — and no document can answer that about itself. Both
 * of them need a human, and deciding them one at a time would deliver
 * whichever was seen first.
 *
 * The archive is passed in rather than read here, and that is the seam this
 * whole file is built around: the decision is a pure function of identifiers,
 * so it can be tested exhaustively without a Yuki session, and the one piece
 * that needs the network is somebody else's problem.
 *
 * Read {@link readYukiArchive} once per run and pass the same archive to every
 * call. Two halves of one decision pass must not see two different archives,
 * and a stale archive must never be reused across runs — deciding to deliver
 * from a mirror that has drifted is precisely how a permanent duplicate is
 * made.
 */
export function decideYukiDelivery(params: {
  documents: readonly YukiDeliveryCandidate[];
  archive: Pick<YukiArchive, "findInvoices" | "findDocuments">;
  /** Defaults to now. Only ever used for rule 5's grace window. */
  now?: Date;
  /** Defaults to {@link DEFAULT_BOOKING_GRACE_DAYS}. */
  bookingGraceDays?: number;
}): YukiDeliveryDecision[] {
  const {
    documents,
    archive,
    now = new Date(),
    bookingGraceDays = DEFAULT_BOOKING_GRACE_DAYS,
  } = params;

  // Everything that can be settled about a document on its own — scope, and
  // rule 1 — is settled first, because rule 2 needs to know which documents
  // have actually established that they carry their number.
  const prepared = documents.map(preclassify);

  // Rule 2's index. A document is a claim on a number only if it got that far:
  // one Midday filed as not financial is not a rival, and neither is one whose
  // number does not appear in its own text — that number was misread, and a
  // misreading must not hold up the document it was misread from.
  const idsByReference = new Map<string, string[]>();
  for (const entry of prepared) {
    if (entry.kind === "resolved") continue;
    const sharing = idsByReference.get(entry.reference);
    if (sharing) sharing.push(entry.document.id);
    else idsByReference.set(entry.reference, [entry.document.id]);
  }

  return prepared.map((entry) =>
    entry.kind === "resolved"
      ? entry.decision
      : decidePrepared({
          entry,
          archive,
          idsByReference,
          now,
          bookingGraceDays,
        }),
  );
}

/**
 * A document after scope and rule 1: either already decided, or carrying a
 * number it has earned the right to be compared on.
 */
type Prepared =
  | { kind: "resolved"; decision: YukiDeliveryDecision }
  | {
      kind: "open";
      document: YukiDeliveryCandidate;
      reference: string;
      delivered: boolean;
    };

function preclassify(document: YukiDeliveryCandidate): Prepared {
  const base = {
    id: document.id,
    comparableReference: null,
    yukiDocuments: [] as readonly YukiArchiveDocument[],
    sharedWith: [] as readonly string[],
  };
  const resolve = (
    action: YukiDeliveryAction,
    reason: YukiAttentionReason | YukiNotApplicableReason,
    comparableReference: string | null = null,
  ): Prepared => ({
    kind: "resolved",
    decision: { ...base, comparableReference, action, reason },
  });

  // Scope first. A document Midday classified as not financial is never sent,
  // and one whose extraction has not finished has no number to work from.
  if (document.type === "other") {
    return resolve("not_applicable", "not_an_invoice");
  }
  if (!isInScope(document.type)) {
    return resolve("not_applicable", "not_extracted");
  }

  const checked = usableReference(document.invoiceNumber);
  const delivered = Boolean(document.deliveredOn);

  // A number with nothing usable in it stops everything, delivered or not:
  // there is no question that can be asked of the archive without one. For a
  // delivered document that is its own kind of wrong — it had a usable number
  // when it went — so it is reported as the delivery not landing rather than as
  // a number problem nobody can act on now.
  if (!checked.ok) {
    return delivered
      ? resolve("needs_attention", "not_booked_after_delivery")
      : resolve("needs_attention", checked.reason);
  }
  const reference = checked.reference;

  // Rule 1's text check is skipped for a document already delivered. Once it
  // has gone, the only open question is whether Yuki booked it, and re-running
  // this check could only turn a delivered document back into `send` — the one
  // answer that cannot be taken back. A text layer that failed to extract on
  // this run must not be able to cause that.
  if (!delivered && !document.structured) {
    if (!document.documentText?.trim()) {
      return resolve("needs_attention", "no_text_layer", reference);
    }
    // Compared on the same normalised form as the number itself, so a supplier
    // who prints "INV 2026 0042" and an extractor that reported "INV-2026-0042"
    // agree. In the measured inbox this passed 13 of 13 — 8 verbatim, 5
    // differing only in spacing or symbols.
    const comparableText = comparableInvoiceReference(document.documentText);
    if (comparableText === null || !comparableText.includes(reference)) {
      return resolve(
        "needs_attention",
        "invoice_number_not_in_document",
        reference,
      );
    }
  }

  return { kind: "open", document, reference, delivered };
}

function isInScope(type: YukiDeliveryCandidate["type"]): boolean {
  // Expenses are receipts, and a receipt is a purchase document Yuki wants just
  // as much as an invoice. Only `other` — Midday's "not a financial document" —
  // is out.
  return type === "invoice" || type === "expense";
}

/**
 * The comparable form of an extracted number, or the rule-1 failure that stops
 * it from being one.
 *
 * Tagged rather than returning `string | reasonCode`, because a reason code is
 * a string too: the two would be indistinguishable at the call site, and the
 * failure mode is a document being delivered with a reason code where its
 * invoice number should be.
 */
type ReferenceCheck =
  | { ok: true; reference: string }
  | {
      ok: false;
      reason: Extract<
        YukiAttentionReason,
        | "no_invoice_number"
        | "invoice_number_unusable"
        | "invoice_number_too_short"
      >;
    };

function usableReference(invoiceNumber: string | null): ReferenceCheck {
  if (!invoiceNumber?.trim()) return { ok: false, reason: "no_invoice_number" };
  const comparable = comparableInvoiceReference(invoiceNumber);
  if (comparable === null) {
    return { ok: false, reason: "invoice_number_unusable" };
  }
  if (comparable.length < MINIMUM_COMPARABLE_REFERENCE_LENGTH) {
    return { ok: false, reason: "invoice_number_too_short" };
  }
  return { ok: true, reference: comparable };
}

function decidePrepared(params: {
  entry: Extract<Prepared, { kind: "open" }>;
  archive: Pick<YukiArchive, "findInvoices" | "findDocuments">;
  idsByReference: Map<string, string[]>;
  now: Date;
  bookingGraceDays: number;
}): YukiDeliveryDecision {
  const { entry, archive, idsByReference, now, bookingGraceDays } = params;
  const { document, reference, delivered } = entry;

  const base = {
    id: document.id,
    comparableReference: reference,
    yukiDocuments: [] as readonly YukiArchiveDocument[],
    sharedWith: [] as readonly string[],
  };

  // Rule 3 — does Yuki already hold an invoice with this number? This also
  // catches Midday's own sales invoices, which Yuki files as type 6, so they
  // are never delivered back in as purchases.
  const invoices = archive.findInvoices(reference);
  if (invoices.length > 0) {
    return { ...base, action: "in_yuki", yukiDocuments: invoices };
  }

  // Rule 5 — a delivered document Yuki has not booked. Nothing below this line
  // can produce `send`, which is the point: it has already gone once.
  if (delivered) {
    const deliveredOn = document.deliveredOn as string;
    return daysBetween(deliveredOn, now) > bookingGraceDays
      ? {
          ...base,
          action: "needs_attention",
          reason: "not_booked_after_delivery",
        }
      : { ...base, action: "not_applicable", reason: "awaiting_yuki" };
  }

  // Rule 2 — does another of Midday's own documents carry this number? An
  // invoice and its billing statement, for instance. Neither is delivered:
  // which of them is the invoice is a question only a person can answer.
  const sharing = idsByReference.get(reference) ?? [];
  if (sharing.length > 1) {
    return {
      ...base,
      action: "needs_attention",
      reason: "shared_invoice_number",
      sharedWith: sharing.filter((id) => id !== document.id),
    };
  }

  // Rule 3\u00bd \u2014 Yuki has the number, but not on an invoice.
  //
  // "No invoice has this number" and "Yuki has never seen this number" are
  // different answers and only the second one means deliver it. A document that
  // has arrived but has not been classified yet looks exactly like this, and it
  // is the state every freshly delivered invoice passes through \u2014 so treating
  // it as absent is how the same invoice gets delivered twice.
  const anyType = archive.findDocuments(reference);
  if (anyType.length > 0) {
    return {
      ...base,
      action: "needs_attention",
      reason: "in_yuki_unclassified",
      yukiDocuments: anyType,
    };
  }

  // Rule 4 \u2014 nothing in Yuki carries this number, and the number is real.
  return { ...base, action: "send" };
}
