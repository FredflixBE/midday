import { getDb } from "@jobs/init";
import { extractErrorDetails } from "@jobs/utils/error-details";
import {
  markInboxAttachmentFailed,
  markStrandedInboxItemsFailed,
} from "@midday/db/queries";
import { logger } from "@trigger.dev/sdk";

/**
 * A run cannot outlive process-attachment's maxDuration of eleven minutes, so
 * anything still "processing" hours later is a row whose owner is gone. Six
 * hours is far enough past that to leave no doubt.
 */
export const STRANDED_AFTER_MINUTES = 6 * 60;

type Attachment = {
  teamId: string;
  filePath: string[];
};

/**
 * Record that an attachment's processing has stopped.
 *
 * An inbox row is created as "processing" before any work happens, and the run
 * that created it is the only thing that ever moves it on. When that run dies
 * the row keeps its spinner forever, which is what a user sees: no error, no
 * status, no way back. This is the write that ends that state.
 *
 * It never throws. Every caller is already on an error path, and a failure
 * here must not replace the error that got us here — that is how one of these
 * rows ended up with no status change at all and a Postgres error in the run
 * where the real cause should have been.
 */
export async function markAttachmentFailed(
  attachment: Attachment,
  reason: string,
): Promise<void> {
  // Not simply filePath.join: onFailure hands back whatever was triggered,
  // including a payload that never passed the task's schema.
  const fileName = Array.isArray(attachment?.filePath)
    ? attachment.filePath.join("/")
    : "unknown";

  try {
    const updated = await markInboxAttachmentFailed(getDb(), {
      filePath: attachment.filePath,
      teamId: attachment.teamId,
    });

    if (updated.length === 0) {
      // Either the row was deleted, or something still alive has already
      // moved it past processing. Neither is ours to correct.
      logger.info("No unfinished inbox item to mark as failed", {
        fileName,
        teamId: attachment.teamId,
        reason,
      });
      return;
    }

    logger.warn("Marked inbox item as failed", {
      fileName,
      teamId: attachment.teamId,
      inboxIds: updated.map((row) => row.id),
      reason,
    });
  } catch (error) {
    logger.error("Could not mark inbox item as failed", {
      fileName,
      teamId: attachment.teamId,
      reason,
      errorDetails: extractErrorDetails(error),
    });
  }
}

/**
 * The items of a batch whose runs did not succeed.
 *
 * `batchTriggerAndWait` returns one result per item, in the order they were
 * triggered, and a result that is not `ok` covers the failures a task cannot
 * report itself: `onFailure` does not run for crashed runs, which is exactly
 * what an out-of-memory kill produces.
 *
 * A length mismatch should not happen, so it is treated as unreadable rather
 * than guessed at: pairing the wrong item with the wrong result would mark a
 * healthy row failed.
 */
export function failedBatchItems<T>(
  items: T[],
  runs: { ok: boolean }[],
): { failed: T[]; unreadable: boolean } {
  if (runs.length !== items.length) {
    return { failed: [], unreadable: true };
  }

  const failed = items.filter((_, index) => runs[index]?.ok === false);

  return { failed, unreadable: false };
}

/**
 * Mark the inbox rows whose processing stopped without ever saying so.
 *
 * The last resort. The parent of a sync batch and the task's own onFailure
 * hook mark their failures as they happen, but neither can see a run that
 * crashed with nothing watching it — a directly triggered attachment killed
 * for running out of memory reaches no hook at all.
 *
 * Never throws: it runs alongside another sweep that must still get its turn.
 */
export async function sweepStrandedAttachments(): Promise<void> {
  try {
    const stranded = await markStrandedInboxItemsFailed(getDb(), {
      olderThanMinutes: STRANDED_AFTER_MINUTES,
    });

    if (stranded.length === 0) {
      logger.info("No stranded inbox items to fail");
      return;
    }

    logger.warn("Marked stranded inbox items as failed", {
      count: stranded.length,
      strandedAfterMinutes: STRANDED_AFTER_MINUTES,
      items: stranded.slice(0, 5).map((item) => ({
        id: item.id,
        teamId: item.teamId,
        displayName: item.displayName,
        createdAt: item.createdAt,
      })),
    });
  } catch (error) {
    logger.error("Failed to sweep stranded inbox items", {
      errorDetails: extractErrorDetails(error),
    });
  }
}
