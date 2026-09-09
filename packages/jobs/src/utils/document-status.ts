import type { UnsupportedFileTypeError } from "@jobs/utils/error-classification";
import { createJobDb } from "@midday/db/job-client";
import { updateDocumentByPath } from "@midday/db/queries";
import { logger } from "@trigger.dev/sdk";

/**
 * These run from task lifecycle hooks, which sit outside the `db` middleware
 * that gives a run its connection, so each opens and closes its own.
 */
async function withDb<T>(
  fn: (db: ReturnType<typeof createJobDb>["db"]) => Promise<T>,
): Promise<T> {
  const { db, disconnect } = createJobDb();
  try {
    return await fn(db);
  } finally {
    await disconnect();
  }
}

/**
 * Mark a document as failed once its run has exhausted every attempt.
 *
 * Without this a document that fails to process sits at "processing" forever
 * and the dashboard never stops showing a spinner for it.
 */
export async function markDocumentFailed(params: {
  pathTokens: string[];
  teamId: string;
}): Promise<void> {
  const { pathTokens, teamId } = params;

  try {
    await withDb((db) =>
      updateDocumentByPath(db, {
        pathTokens,
        teamId,
        processingStatus: "failed",
      }),
    );

    logger.info("Document status updated to failed", {
      filePath: pathTokens.join("/"),
      teamId,
    });
  } catch (error) {
    // The run has already failed; losing the status update must not mask why.
    logger.error("Failed to update document status to failed", {
      filePath: pathTokens.join("/"),
      teamId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

/**
 * Complete a document whose file type cannot be read.
 *
 * This is not a failure: the file is stored and downloadable, there is just no
 * content to extract. Titling it with its filename keeps it out of the
 * "needs classification" state in the UI.
 */
export async function markDocumentUnsupported(params: {
  pathTokens: string[];
  teamId: string;
  error: UnsupportedFileTypeError;
}): Promise<void> {
  const { pathTokens, teamId, error } = params;
  const displayName = pathTokens.at(-1) ?? "Document";

  try {
    await withDb((db) =>
      updateDocumentByPath(db, {
        pathTokens,
        teamId,
        title: displayName,
        summary: `File type (${error.mimetype}) is not supported for content extraction`,
        processingStatus: "completed",
      }),
    );

    logger.info("Unsupported file type marked as completed", {
      filePath: pathTokens.join("/"),
      mimetype: error.mimetype,
      teamId,
    });
  } catch (updateError) {
    logger.error("Failed to handle unsupported file type", {
      filePath: pathTokens.join("/"),
      teamId,
      error:
        updateError instanceof Error ? updateError.message : "Unknown error",
    });
  }
}
