import type { Database } from "@midday/db/client";
import {
  getInboxDocumentsForYukiDelivery,
  type InboxDocumentForYukiDelivery,
  yukiDocumentIdFrom,
} from "@midday/db/queries";
import type { YukiArchive, YukiArchiveReader } from "@midday/yuki/archive";
import { readYukiArchive } from "@midday/yuki/archive";
import type {
  YukiDeliveryAction,
  YukiDeliveryCandidate,
  YukiDeliveryDecision,
} from "@midday/yuki/decide";
import { decideYukiDelivery, requiresDocumentText } from "@midday/yuki/decide";

/**
 * Runs FF-1493's decision over a team's whole inbox.
 *
 * Everything that touches the world is a parameter — the archive comes from a
 * client, the text layers come from a function the caller supplies — so this
 * can be run end to end in a test without a Yuki session or a storage bucket,
 * and so the decision itself stays the pure thing it is.
 *
 * Read only. Nothing here writes to Midday or to Yuki. FF-1458 acts on the
 * `send` list; FF-1499 shows the `needs_attention` ones.
 */

/** How many text layers to fetch at once. */
const TEXT_EXTRACTION_CONCURRENCY = 5;

/**
 * A decision, plus the one fact about the document that is not yet allowed to
 * change it (FF-1493, decided 2026-09-12).
 *
 * A document matched to a real Midday transaction is a purchase the business
 * demonstrably made. That is a second identifier — a link Midday created, not
 * an amount — and it is the gate this integration wants before delivering
 * anything into live books: *Yuki does not have it* **and** *we really bought
 * it*. The first live run turned up a 8,712 EUR document that passes every rule
 * here, matches no transaction, and is not an invoice at all.
 *
 * It is reported and not enforced because it cannot be satisfied yet. Five of
 * 131 inbox documents match a transaction, since KBC's open banking consent
 * does not expose the business Mastercard and 68 of Yuki's 81 missing payments
 * are card charges. Gating on it today would block 49 of the 51 deliverable
 * documents — the whole backlog the epic exists to clear. FF-1517 connects the
 * card as a bank connection; once the match rate is real, this becomes a
 * condition in `decideYukiDelivery` rather than a column in a report.
 */
export type YukiDeliveryDecisionWithContext = YukiDeliveryDecision & {
  matchedTransactionId: string | null;
};

export interface YukiDeliveryReport {
  teamId: string;
  /** What the archive read cost and how fresh it is, for the run log. */
  archive: { documents: number; folders: number; calls: number; readAt: Date };
  /** How many text layers were actually fetched, of how many documents. */
  textLayersRead: { fetched: number; ofDocuments: number };
  counts: Record<YukiDeliveryAction, number>;
  /** Per reason code, across `needs_attention` and `not_applicable`. */
  reasons: Record<string, number>;
  /**
   * How many of the `send` documents match no Midday transaction.
   *
   * The number to watch, and today it is nearly all of them. See
   * {@link YukiDeliveryDecisionWithContext} for why that is expected and what
   * changes it.
   */
  sendWithoutTransaction: number;
  decisions: YukiDeliveryDecisionWithContext[];
}

/**
 * Reads one document's text layer, or answers null when it has none.
 *
 * Null is a real answer here — a scan, an image, a PDF whose text could not be
 * read — and the decision turns it into *Needs attention: no text layer*. So an
 * implementation should return null on failure rather than throw: a storage
 * hiccup on one document should not abandon the other nine hundred.
 */
export type ReadDocumentText = (
  document: InboxDocumentForYukiDelivery,
) => Promise<string | null>;

export async function reportYukiDelivery(params: {
  db: Database;
  teamId: string;
  client: YukiArchiveReader;
  readDocumentText: ReadDocumentText;
  now?: Date;
}): Promise<YukiDeliveryReport> {
  const { db, teamId, client, readDocumentText, now } = params;

  // The archive is read once, at the top, and the same one answers every
  // document below. Two halves of one pass must not see two different
  // archives, and it must never be carried over from a previous run: this is
  // the decision that delivers into live books, and Yuki has no delete.
  const [archive, documents] = await Promise.all([
    readYukiArchive(client),
    getInboxDocumentsForYukiDelivery(db, { teamId }),
  ]);

  return summariseYukiDelivery({
    teamId,
    documents,
    archive,
    readDocumentText,
    now,
  });
}

/**
 * Everything {@link reportYukiDelivery} does once the two reads have happened.
 *
 * Split out because it is the part with judgement in it — which text layers are
 * worth fetching, and what the run is then reported as — and the split is what
 * lets that be tested against a fixture archive and a fixed list of documents,
 * with no database and no Yuki session anywhere near it.
 */
export async function summariseYukiDelivery(params: {
  teamId: string;
  documents: InboxDocumentForYukiDelivery[];
  archive: YukiArchive;
  readDocumentText: ReadDocumentText;
  now?: Date;
}): Promise<YukiDeliveryReport> {
  const { teamId, documents, archive, readDocumentText, now } = params;

  const candidates = await buildCandidates(documents, readDocumentText);
  const decided = decideYukiDelivery({
    documents: candidates,
    archive,
    now,
  });

  // The match is attached here rather than passed into the decision, so that a
  // field which must not decide anything yet is not even in front of the code
  // that decides.
  const matchedById = new Map(
    documents.map((d) => [d.id, d.matchedTransactionId]),
  );
  const decisions: YukiDeliveryDecisionWithContext[] = decided.map((d) => ({
    ...d,
    matchedTransactionId: matchedById.get(d.id) ?? null,
  }));

  return {
    teamId,
    archive: archiveStats(archive),
    textLayersRead: {
      fetched: candidates.filter((c) => c.documentText !== null).length,
      ofDocuments: documents.length,
    },
    counts: countActions(decisions),
    reasons: countBy(decisions, (d) => d.reason),
    sendWithoutTransaction: decisions.filter(
      (d) => d.action === "send" && d.matchedTransactionId === null,
    ).length,
    decisions,
  };
}

/**
 * All four actions, always, including the zeroes. A run that sent nothing and a
 * run whose `send` count went missing look identical otherwise, and the first
 * is normal while the second is a bug.
 */
function countActions(
  decisions: readonly YukiDeliveryDecisionWithContext[],
): Record<YukiDeliveryAction, number> {
  const counts: Record<YukiDeliveryAction, number> = {
    send: 0,
    in_yuki: 0,
    needs_attention: 0,
    not_applicable: 0,
  };
  for (const decision of decisions) counts[decision.action] += 1;
  return counts;
}

function archiveStats(archive: YukiArchive) {
  return {
    documents: archive.documents.length,
    folders: archive.folders.length,
    calls: archive.calls,
    readAt: archive.readAt,
  };
}

async function buildCandidates(
  documents: InboxDocumentForYukiDelivery[],
  readDocumentText: ReadDocumentText,
): Promise<YukiDeliveryCandidate[]> {
  const pairs = documents.map((document) => ({
    document,
    candidate: {
      id: document.id,
      invoiceNumber: document.invoiceNumber,
      type: document.type,
      documentText: null,
      // A document pulled out of Yuki's archive (FF-1450) carries the invoice
      // number Yuki itself stores, as a field. There is no page to read it off
      // and nothing to verify it against, so rule 1's text-layer check is
      // skipped for it — otherwise every pulled document would land in *Needs
      // attention: no text layer* for want of a PDF nobody needs to read.
      structured: yukiDocumentIdFrom(document.referenceId) !== null,
      // Derived here, where amounts are legitimately in hand for display, so
      // that the decision is handed a fact — "this charges nothing" — rather
      // than a number it might be tempted to compare. Zero is exact in every
      // currency, which is what separates it from the amounts the integration
      // refuses to decide on.
      zeroTotal: document.amount === 0,
      // Likewise: no delivery record exists until FF-1458 creates one, so every
      // document here is undelivered. The decision already refuses to re-send a
      // delivered document; this is where FF-1458 tells it which those are.
      deliveredOn: null,
    } satisfies YukiDeliveryCandidate as YukiDeliveryCandidate,
  }));

  // Only the documents that will reach rule 1's check are worth downloading.
  const needed = pairs.filter(({ candidate }) =>
    requiresDocumentText(candidate),
  );

  for (let i = 0; i < needed.length; i += TEXT_EXTRACTION_CONCURRENCY) {
    await Promise.all(
      needed
        .slice(i, i + TEXT_EXTRACTION_CONCURRENCY)
        .map(async ({ document, candidate }) => {
          candidate.documentText = await readDocumentText(document);
        }),
    );
  }

  return pairs.map(({ candidate }) => candidate);
}

function countBy<T>(
  items: readonly T[],
  key: (item: T) => string | undefined,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    if (k === undefined) continue;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}
