import { getDb } from "@jobs/init";
import {
  failedBatchItems,
  markAttachmentFailed,
} from "@jobs/utils/attachment-failure";
import { inboxFileName, MESSAGES_PER_BATCH } from "@jobs/utils/inbox-sync";
import { recordSyncFailure } from "@jobs/utils/inbox-sync-failure";
import { processBatch } from "@jobs/utils/process-batch";
import { getInboxAccountInfo, getInboxBlocklist } from "@midday/db/queries";
import { separateBlocklistEntries } from "@midday/db/utils/blocklist";
import { InboxConnector } from "@midday/inbox/connector";
import { createClient } from "@midday/supabase/job";
import { getExistingInboxAttachmentsQuery } from "@midday/supabase/queries";
import { AbortTaskRunError, logger, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { processAttachment } from "../process-attachment";

const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10MB
const UPLOADS_AT_A_TIME = 5;

/**
 * Read one batch of an inbox account's messages: fetch their PDFs, pass over
 * what is already in the inbox, too large or blocked, and wait for the rest
 * to be processed. `sync-inbox-account` lists the messages and runs this once
 * per batch, so no single run's duration grows with the size of the mailbox.
 *
 * Trigger it with the account id as `concurrencyKey`: one batch per account
 * at a time keeps a mailbox under Gmail's per-user quota, and keeps two syncs
 * of the same mailbox from racing each other past the dedup.
 */
export const syncInboxMessages = schemaTask({
  id: "sync-inbox-messages",
  schema: z.object({
    id: z.string(),
    messageIds: z.array(z.string()).min(1).max(MESSAGES_PER_BATCH),
  }),
  maxDuration: 120,
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 5000,
    maxTimeoutInMs: 60000,
    factor: 2,
    randomize: true,
  },
  queue: {
    concurrencyLimit: 1,
  },
  machine: {
    preset: "medium-1x",
  },
  run: async ({ id, messageIds }) => {
    const supabase = createClient();

    const accountRow = await getInboxAccountInfo(getDb(), { id });

    if (!accountRow) {
      throw new AbortTaskRunError("Account not found");
    }

    const connector = new InboxConnector(accountRow.provider, getDb());

    try {
      const attachments = await connector.getMessageAttachments({
        id,
        teamId: accountRow.teamId,
        messageIds,
      });

      logger.info("Fetched attachments from provider", {
        accountId: id,
        messageCount: messageIds.length,
        totalFound: attachments.length,
        provider: accountRow.provider,
      });

      // Filter out attachments that are already processed
      const existingAttachments = await getExistingInboxAttachmentsQuery(
        supabase,
        attachments.map((attachment) => attachment.referenceId),
      );

      // Get blocklist entries for the team
      const blocklistEntries = await getInboxBlocklist(getDb(), {
        teamId: accountRow.teamId,
      });

      const { blockedDomains, blockedEmails } =
        separateBlocklistEntries(blocklistEntries);

      // Track filtering statistics
      let skippedAlreadyProcessed = 0;
      let skippedTooLarge = 0;
      let skippedBlockedDomain = 0;
      let skippedBlockedEmail = 0;

      const filteredAttachments = attachments.filter((attachment) => {
        // Skip if already exists in database
        if (
          existingAttachments.data?.some(
            (existing: { reference_id: string | null }) =>
              existing.reference_id === attachment.referenceId,
          )
        ) {
          skippedAlreadyProcessed++;
          return false;
        }

        // Skip if attachment is too large
        if (attachment.size > MAX_ATTACHMENT_SIZE) {
          skippedTooLarge++;
          logger.warn("Attachment exceeds size limit", {
            filename: attachment.filename,
            size: attachment.size,
            maxSize: MAX_ATTACHMENT_SIZE,
            accountId: id,
          });
          return false;
        }

        // Skip if domain is blocked
        if (attachment.website) {
          const domain = attachment.website.toLowerCase();
          if (blockedDomains.includes(domain)) {
            skippedBlockedDomain++;
            logger.info("Skipping attachment - domain blocked", {
              filename: attachment.filename,
              website: attachment.website,
              blockedDomain: domain,
              accountId: id,
            });

            return false;
          }
        }

        // Skip if sender email is blocked
        if (attachment.senderEmail) {
          const email = attachment.senderEmail.toLowerCase();
          if (blockedEmails.includes(email)) {
            skippedBlockedEmail++;
            logger.info("Skipping attachment - sender email blocked", {
              filename: attachment.filename,
              senderEmail: attachment.senderEmail,
              blockedEmail: email,
              accountId: id,
            });

            return false;
          }
        }

        return true;
      });

      logger.info("Attachment filtering summary", {
        accountId: id,
        totalFound: attachments.length,
        afterFiltering: filteredAttachments.length,
        skipped: attachments.length - filteredAttachments.length,
        skippedByReason: {
          alreadyProcessed: skippedAlreadyProcessed,
          tooLarge: skippedTooLarge,
          blockedDomain: skippedBlockedDomain,
          blockedEmail: skippedBlockedEmail,
        },
        blocklistStats: {
          blockedDomainsCount: blockedDomains.length,
          blockedEmailsCount: blockedEmails.length,
          totalBlocklistEntries: blocklistEntries.length,
        },
      });

      const uploadedAttachments = await processBatch(
        filteredAttachments,
        UPLOADS_AT_A_TIME,
        async (batch) => {
          const results = [];
          for (const item of batch) {
            const fileName = inboxFileName(item);

            const { data: uploadData, error: uploadError } =
              await supabase.storage
                .from("vault")
                .upload(`${accountRow.teamId}/inbox/${fileName}`, item.data, {
                  contentType: item.mimeType,
                  upsert: true,
                });

            // An attachment that never reached storage was never read: fail
            // the batch rather than let the sync move past it.
            if (uploadError) throw uploadError;

            if (uploadData) {
              results.push({
                // A queued run expires after ten minutes in the development
                // environment, and the whole point of a bounded queue is that
                // the back of a large mailbox waits its turn. Waiting is not
                // the same as being abandoned.
                options: { ttl: "1h" },
                payload: {
                  filePath: uploadData.path.split("/"),
                  size: item.size,
                  mimetype: item.mimeType,
                  website: item.website,
                  senderEmail: item.senderEmail,
                  referenceId: item.referenceId,
                  teamId: accountRow.teamId,
                  inboxAccountId: id,
                },
              });
            }
          }

          return results;
        },
      );

      logger.info("Attachment processing summary", {
        accountId: id,
        totalFetched: attachments.length,
        afterFiltering: filteredAttachments.length,
        uploaded: uploadedAttachments.length,
        skipped: attachments.length - filteredAttachments.length,
      });

      if (uploadedAttachments.length > 0) {
        // Waiting is also what paces a backfill: the next batch is not read
        // until this one's documents are through the pipeline.
        const processed =
          await processAttachment.batchTriggerAndWait(uploadedAttachments);

        // A run that crashed — an out-of-memory kill is the one seen here —
        // never reaches its own onFailure hook, so its inbox row would keep
        // the "processing" status it was created with. This is the only place
        // that learns those runs are over.
        const { failed, unreadable } = failedBatchItems(
          uploadedAttachments,
          processed.runs,
        );

        if (unreadable) {
          logger.error(
            "Batch returned a result per run that cannot be paired",
            {
              accountId: id,
              attachmentCount: uploadedAttachments.length,
              runCount: processed.runs.length,
            },
          );
        }

        if (failed.length > 0) {
          logger.warn("Attachments did not process", {
            accountId: id,
            teamId: accountRow.teamId,
            failedCount: failed.length,
            attachmentCount: uploadedAttachments.length,
          });

          for (const item of failed) {
            await markAttachmentFailed(item.payload, "run did not complete");
          }
        }
      }

      return { attachmentsProcessed: uploadedAttachments.length };
    } catch (error) {
      await recordSyncFailure(error, {
        accountId: id,
        provider: accountRow.provider,
      });
      throw error;
    }
  },
});
