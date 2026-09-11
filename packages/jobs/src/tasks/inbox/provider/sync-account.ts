import { getDb } from "@jobs/init";
import { syncMailbox } from "@jobs/utils/inbox-sync";
import { recordSyncFailure } from "@jobs/utils/inbox-sync-failure";
import { getInboxAccountInfo, updateInboxAccount } from "@midday/db/queries";
import { InboxConnector } from "@midday/inbox/connector";
import { syncStartProblem } from "@midday/inbox/sync-start";
import { AbortTaskRunError, logger, schemaTask, tasks } from "@trigger.dev/sdk";
import { z } from "zod";
import { syncInboxMessages } from "./sync-messages";

/**
 * Sync an inbox account: list every message since the account's watermark,
 * and read them a batch at a time in `sync-inbox-messages`.
 *
 * Pass `since` (YYYY-MM-DD) to backfill from that date instead, at most one
 * year back. A backfill is safe to run again: what an earlier run read is
 * passed over by reference id.
 */
export const syncInboxAccount = schemaTask({
  id: "sync-inbox-account",
  schema: z.object({
    id: z.string(),
    manualSync: z.boolean().optional(),
    // Validated below, against the one-year limit, with a message that says
    // what was wrong.
    since: z.string().optional(),
  }),
  // Listing a mailbox takes a request per 500 messages, and the time spent
  // waiting on the batches does not count towards this.
  maxDuration: 120,
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 5000,
    maxTimeoutInMs: 60000,
    factor: 2,
    randomize: true,
  },
  queue: {
    concurrencyLimit: 10,
  },
  run: async (payload) => {
    const { id, manualSync = false, since } = payload;
    const startedAt = new Date();

    // The API refuses the same dates when the user picks one; this is the
    // check a sync triggered by hand, with any date, cannot get around.
    const sinceProblem = since && syncStartProblem(since, startedAt);
    if (sinceProblem) {
      throw new AbortTaskRunError(sinceProblem);
    }

    // Get the account info to access provider and teamId
    const accountRow = await getInboxAccountInfo(getDb(), { id });

    if (!accountRow) {
      // Retrying cannot bring a deleted account back. Its schedule removes
      // itself (see inbox-sync-scheduler), so this is only reached by a sync
      // requested just as the account was deleted.
      throw new AbortTaskRunError("Account not found");
    }

    const connector = new InboxConnector(accountRow.provider, getDb());

    logger.info("Starting inbox sync", {
      accountId: id,
      teamId: accountRow.teamId,
      provider: accountRow.provider,
      lastAccessed: accountRow.lastAccessed,
      manualSync,
      since,
    });

    let batchesRun = 0;

    const result = await syncMailbox({
      lastAccessed: accountRow.lastAccessed,
      since,
      fullSync: manualSync,
      startedAt,
      listMessageIds: async (windowStart) => {
        try {
          const messageIds = await connector.listMessageIds({
            id,
            teamId: accountRow.teamId,
            since: windowStart,
          });

          logger.info("Listed messages to sync", {
            accountId: id,
            since: windowStart.toISOString(),
            messageCount: messageIds.length,
          });

          return messageIds;
        } catch (error) {
          await recordSyncFailure(error, {
            accountId: id,
            provider: accountRow.provider,
          });
          throw error;
        }
      },
      syncBatch: async (messageIds) => {
        const run = await syncInboxMessages.triggerAndWait(
          { id, messageIds },
          // Behind another sync's batch of the same mailbox, a run can wait
          // longer than the development environment's ten-minute default.
          { concurrencyKey: id, ttl: "1h" },
        );
        batchesRun++;

        if (!run.ok) {
          throw new Error(
            `Batch ${batchesRun} (run ${run.id}) failed: ${
              run.error instanceof Error
                ? run.error.message
                : JSON.stringify(run.error)
            }`,
          );
        }

        logger.info("Synced a batch of messages", {
          accountId: id,
          batch: batchesRun,
          messageCount: messageIds.length,
          attachmentsProcessed: run.output.attachmentsProcessed,
        });

        return run.output.attachmentsProcessed;
      },
    });

    if (result.attachmentsProcessed > 0) {
      // Send notification for new inbox items
      await tasks.trigger("notification", {
        type: "inbox_new",
        teamId: accountRow.teamId,
        totalCount: result.attachmentsProcessed,
        inboxType: "sync",
        provider: accountRow.provider,
      });
    }

    if (result.error) {
      // The batch run has retried already, and a retry here would read the
      // whole window again, so the run ends as failed instead.
      throw new AbortTaskRunError(
        `Sync stopped short; lastAccessed left at ${accountRow.lastAccessed}. ${
          result.error instanceof Error ? result.error.message : result.error
        }`,
      );
    }

    // Mark as connected and clear errors; move the watermark only when the
    // whole window since it was read.
    await updateInboxAccount(getDb(), {
      id,
      lastAccessed: result.lastAccessed ?? undefined,
      status: "connected",
      errorMessage: null,
    });

    logger.info("Inbox sync completed", {
      accountId: id,
      since: result.since.toISOString(),
      messages: result.messages,
      processedAttachments: result.attachmentsProcessed,
      lastAccessed: result.lastAccessed ?? accountRow.lastAccessed,
    });

    // Return the attachment count for the frontend
    return {
      accountId: id,
      attachmentsProcessed: result.attachmentsProcessed,
      syncedAt: new Date().toISOString(),
    };
  },
});
