import type { Database } from "@midday/db/client";
import {
  getInboxDocumentsForYukiDelivery,
  type InboxDocumentForYukiDelivery,
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

export interface YukiDeliveryReport {
  teamId: string;
  /** What the archive read cost and how fresh it is, for the run log. */
  archive: { documents: number; folders: number; calls: number; readAt: Date };
  /** How many text layers were actually fetched, of how many documents. */
  textLayersRead: { fetched: number; ofDocuments: number };
  counts: Record<YukiDeliveryAction, number>;
  /** Per reason code, across `needs_attention` and `not_applicable`. */
  reasons: Record<string, number>;
  decisions: YukiDeliveryDecision[];
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
  const decisions = decideYukiDelivery({
    documents: candidates,
    archive,
    now,
  });

  return {
    teamId,
    archive: archiveStats(archive),
    textLayersRead: {
      fetched: candidates.filter((c) => c.documentText !== null).length,
      ofDocuments: documents.length,
    },
    counts: countActions(decisions),
    reasons: countBy(decisions, (d) => d.reason),
    decisions,
  };
}

/**
 * All four actions, always, including the zeroes. A run that sent nothing and a
 * run whose `send` count went missing look identical otherwise, and the first
 * is normal while the second is a bug.
 */
function countActions(
  decisions: readonly YukiDeliveryDecision[],
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
  const candidates: YukiDeliveryCandidate[] = documents.map((document) => ({
    id: document.id,
    invoiceNumber: document.invoiceNumber,
    type: document.type,
    documentText: null,
    // Midday has no Peppol ingestion yet, so nothing arrives as structured
    // data and nothing skips rule 1's text check. When FF-1453 adds one, this
    // is the line it sets — and until then saying so explicitly is better than
    // letting the field default and reading as if it had been considered.
    structured: false,
    // Likewise: no delivery record exists until FF-1458 creates one, so every
    // document here is undelivered. The decision already refuses to re-send a
    // delivered document; this is where FF-1458 tells it which those are.
    deliveredOn: null,
  }));

  // Only the documents that will reach rule 1's check are worth downloading.
  const needed = candidates.filter(requiresDocumentText);
  const byId = new Map(documents.map((d) => [d.id, d]));

  for (let i = 0; i < needed.length; i += TEXT_EXTRACTION_CONCURRENCY) {
    const batch = needed.slice(i, i + TEXT_EXTRACTION_CONCURRENCY);
    await Promise.all(
      batch.map(async (candidate) => {
        const document = byId.get(candidate.id);
        if (!document) return;
        candidate.documentText = await readDocumentText(document);
      }),
    );
  }

  return candidates;
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
