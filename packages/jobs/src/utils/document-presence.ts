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
 * Explain a half of the document that has already been found missing, and say
 * so in the log — the two causes must stay distinguishable there.
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
    logger.info("Document was deleted while the job was running", {
      fileName,
      teamId,
      missing,
    });

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
 * Cheap enough to call before an expensive step: it only reaches storage when
 * the row has already turned up missing. A row missing on its own is not
 * reported as deleted, because it may simply not have been written yet — that
 * race is what `updateDocumentWithRetry` in ./document-update.ts retries for.
 */
export async function documentWasDeleted(ref: DocumentRef): Promise<boolean> {
  if ((await documentRowPresence(ref)) !== "absent") {
    return false;
  }

  return (
    (await explainMissingDocument({ ...ref, missing: "row" })) === "deleted"
  );
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
 * What a document task did, so a parent waiting on it can tell real work from
 * a quiet exit and stop rather than announce a document that no longer exists.
 */
export type DocumentTaskOutcome =
  | { status: "completed" }
  | { status: "skipped"; reason: "document-deleted" };

/** The result every document task returns when the item was deleted under it. */
export const documentDeletedOutcome: DocumentTaskOutcome = {
  status: "skipped",
  reason: "document-deleted",
};
