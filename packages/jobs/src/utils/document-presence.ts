import type { JobLogger } from "@jobs/processors/types";
import type { Database } from "@midday/db/client";
import { documentExistsByPath } from "@midday/db/queries";
import { createClient } from "@midday/supabase/job";

/**
 * A vault document has two halves: the file in the `vault` bucket and the
 * `public.documents` row. Triggers on `storage.objects` create and drop the
 * two together (packages/db/supabase/50-documents.sql) — nothing in this
 * repository inserts or deletes a documents row on its own.
 *
 * That pairing is what lets a job say *why* the half it needs is gone: it asks
 * about the other half.
 *
 * - `deleted` — both halves are gone, so the item was removed while the job
 *   was running. A normal ending: there is no work left and nothing to write
 *   to.
 * - `orphaned` — the other half is still there, so the missing one was never
 *   created. That is an upstream bug and has to stay loud; exiting quietly on
 *   this case too would turn a real bug into silence.
 * - `unknown` — the check itself failed, so the two cannot be told apart. We
 *   assume the worse of them and stay loud.
 */
export type MissingDocumentCause = "deleted" | "orphaned" | "unknown";

/** Which half of the document the caller already knows is missing. */
export type MissingDocumentHalf = "row" | "file";

type Presence = "present" | "absent" | "unknown";

type DocumentRef = {
  /**
   * The run's own connection. Storage, by contrast, is reached through a
   * client created here: it carries no per-run state, where the database
   * connection comes from the middleware and has to be the one the caller
   * already holds.
   */
  db: Database;
  /** Full vault path, e.g. "teamId/inbox/invoice.pdf". */
  fileName: string;
  teamId: string;
  logger: JobLogger;
};

async function vaultFilePresence({
  fileName,
  teamId,
  logger,
}: Omit<DocumentRef, "db">): Promise<Presence> {
  try {
    const supabase = createClient();
    // A HEAD request, so this costs nothing next to downloading the file
    // again. `exists` reports 400 and 404 as `data: false` and throws on
    // anything else, which is the distinction we want.
    const { data } = await supabase.storage.from("vault").exists(fileName);

    return data ? "present" : "absent";
  } catch (error) {
    logger.warn("Could not check whether the vault file still exists", {
      fileName,
      teamId,
      error: error instanceof Error ? error.message : "Unknown error",
    });

    return "unknown";
  }
}

async function documentRowPresence({
  db,
  fileName,
  teamId,
  logger,
}: DocumentRef): Promise<Presence> {
  try {
    const exists = await documentExistsByPath(db, {
      pathTokens: fileName.split("/"),
      teamId,
    });

    return exists ? "present" : "absent";
  } catch (error) {
    logger.warn("Could not check whether the documents row still exists", {
      fileName,
      teamId,
      error: error instanceof Error ? error.message : "Unknown error",
    });

    return "unknown";
  }
}

/**
 * The line every quiet exit turns on. It states what was observed rather than
 * what it implies: both halves being gone is overwhelmingly a deletion, but a
 * run started against a path that never existed would look the same, and the
 * log should not claim more than it saw.
 */
function logBothHalvesGone({ fileName, teamId, logger }: DocumentRef): void {
  logger.info(
    "Neither the file nor its documents row is there - treating the document as deleted",
    { fileName, teamId },
  );
}

/**
 * Explain a half of the document that has already been found missing, and say
 * so in the log — the two causes must stay distinguishable there.
 *
 * Only for a half found missing *after* the document was known to be there.
 * At the start of a run use {@link documentWasDeleted} instead: a row that has
 * not been written yet is not yet an orphan.
 */
export async function explainMissingDocument({
  missing,
  ...ref
}: DocumentRef & {
  missing: MissingDocumentHalf;
}): Promise<MissingDocumentCause> {
  const { fileName, teamId, logger } = ref;
  const other =
    missing === "row"
      ? await vaultFilePresence(ref)
      : await documentRowPresence(ref);

  if (other === "absent") {
    logBothHalvesGone(ref);

    return "deleted";
  }

  if (other === "unknown") {
    logger.error(
      "Could not tell a deleted document from one that is half-missing",
      { fileName, teamId, missing },
    );

    return "unknown";
  }

  logger.error(
    missing === "row"
      ? "File is in the vault but has no documents row — the row was never created"
      : "Document row exists but its file is gone from the vault",
    { fileName, teamId },
  );

  return "orphaned";
}

/**
 * Whether the document has already been deleted — both halves gone.
 *
 * Cheap enough to call before an expensive step: it only reaches storage once
 * the row has already turned up missing.
 *
 * Unlike {@link explainMissingDocument} this says nothing when the answer is
 * no. A row missing while its file is there means the row has not been written
 * yet as often as it means it never will be — that is the race
 * `updateDocumentWithRetry` in ./document-update.ts retries for — and calling
 * it a bug this early would be a false alarm on every one of them.
 */
export async function documentWasDeleted(ref: DocumentRef): Promise<boolean> {
  if ((await documentRowPresence(ref)) !== "absent") {
    return false;
  }

  if ((await vaultFilePresence(ref)) !== "absent") {
    return false;
  }

  logBothHalvesGone(ref);

  return true;
}

/**
 * Whether a file that would not download is gone because the whole document
 * was deleted, rather than missing while its row is still there.
 */
export async function fileMissingBecauseDeleted(
  ref: DocumentRef,
): Promise<boolean> {
  return (
    (await explainMissingDocument({ ...ref, missing: "file" })) === "deleted"
  );
}

/**
 * What a classification task did, so the `process-document` run waiting on it
 * can tell real work from a quiet exit and stop rather than announce a
 * document that no longer exists.
 */
export type ClassificationOutcome =
  | { status: "completed" }
  | { status: "skipped"; reason: "document-deleted" };

/** The result a classification returns when the item was deleted under it. */
export const documentDeletedOutcome: ClassificationOutcome = {
  status: "skipped",
  reason: "document-deleted",
};

/**
 * The ending for a classification whose update matched no rows.
 *
 * Returns the quiet outcome when the document was deleted, and **throws**
 * otherwise: a row that is gone while its file is still in the vault was never
 * created, which is an upstream bug and the one case that must not go quiet.
 */
export async function outcomeForMissingRow(
  ref: DocumentRef,
): Promise<ClassificationOutcome> {
  const cause = await explainMissingDocument({ ...ref, missing: "row" });

  if (cause === "deleted") {
    return documentDeletedOutcome;
  }

  throw new Error(`Document with path ${ref.fileName} not found`);
}
