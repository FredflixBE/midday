import {
  confirmMatchSchema,
  createInboxBlocklistSchema,
  createInboxItemSchema,
  declineMatchSchema,
  deleteInboxBlocklistSchema,
  deleteInboxManySchema,
  deleteInboxSchema,
  getInboxBlocklistSchema,
  getInboxByIdSchema,
  getInboxByStatusSchema,
  getInboxSchema,
  matchTransactionSchema,
  processAttachmentsSchema,
  retryMatchingSchema,
  retryProcessingSchema,
  searchInboxSchema,
  unmatchTransactionSchema,
  updateInboxSchema,
} from "@api/schemas/inbox";
import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import {
  checkInboxAttachments,
  confirmSuggestedMatch,
  createInbox,
  createInboxBlocklist,
  declineSuggestedMatch,
  deleteInbox,
  deleteInboxBlocklist,
  deleteInboxMany,
  getInbox,
  getInboxBlocklist,
  getInboxById,
  getInboxByStatus,
  getInboxForReprocessing,
  getInboxSearch,
  matchTransaction,
  unmatchTransaction,
  updateInbox,
} from "@midday/db/queries";
import type {
  BatchProcessMatchingPayload,
  ProcessAttachmentPayload,
} from "@midday/jobs/schemas/inbox";
import type { NotificationInput } from "@midday/jobs/schemas/notifications";
import { logger } from "@midday/logger";
import { remove } from "@midday/supabase/storage";
import { tasks } from "@trigger.dev/sdk";
import { TRPCError } from "@trpc/server";

export const inboxRouter = createTRPCRouter({
  get: protectedProcedure
    .input(getInboxSchema.optional())
    .query(async ({ ctx: { db, teamId }, input }) => {
      return getInbox(db, {
        teamId: teamId!,
        ...input,
      });
    }),

  getById: protectedProcedure
    .input(getInboxByIdSchema)
    .query(async ({ ctx: { db, teamId }, input }) => {
      return getInboxById(db, {
        id: input.id,
        teamId: teamId!,
      });
    }),

  checkAttachments: protectedProcedure
    .input(deleteInboxSchema)
    .query(async ({ ctx: { db, teamId }, input }) => {
      return checkInboxAttachments(db, {
        id: input.id,
        teamId: teamId!,
      });
    }),

  delete: protectedProcedure
    .input(deleteInboxSchema)
    .mutation(async ({ ctx: { db, supabase, teamId }, input }) => {
      // Delete inbox item and get filePath for storage cleanup
      const result = await deleteInbox(db, {
        id: input.id,
        teamId: teamId!,
      });

      // Delete file from storage if filePath exists
      if (result?.filePath && result.filePath.length > 0) {
        try {
          await remove(supabase, {
            bucket: "vault",
            path: result.filePath,
          });
        } catch (error) {
          // Log error but don't fail the deletion if file doesn't exist in storage
          logger.error("Failed to delete file from storage", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }),

  deleteMany: protectedProcedure
    .input(deleteInboxManySchema)
    .mutation(async ({ ctx: { db, supabase, teamId }, input }) => {
      // Delete inbox items and get filePaths for storage cleanup
      const results = await deleteInboxMany(db, {
        ids: input,
        teamId: teamId!,
      });

      // Delete files from storage and embeddings
      await Promise.all(
        results
          .filter((result) => result?.filePath && result.filePath.length > 0)
          .map(async (result) => {
            try {
              await remove(supabase, {
                bucket: "vault",
                path: result.filePath!,
              });
            } catch (error) {
              logger.error("Failed to delete file from storage", {
                inboxId: result.id,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }),
      );

      return results;
    }),

  create: protectedProcedure
    .input(createInboxItemSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      return createInbox(db, {
        displayName: input.filename,
        teamId: teamId!,
        filePath: input.filePath,
        fileName: input.filename,
        contentType: input.mimetype,
        size: input.size,
        status: "processing",
      });
    }),

  processAttachments: protectedProcedure
    .input(processAttachmentsSchema)
    .mutation(async ({ ctx: { teamId }, input }) => {
      const jobResults = await Promise.all(
        input.map((item) =>
          tasks.trigger("process-attachment", {
            filePath: item.filePath,
            mimetype: item.mimetype,
            size: item.size,
            teamId: teamId!,
            referenceId: item.referenceId,
            website: item.website,
            senderEmail: item.senderEmail,
            inboxAccountId: item.inboxAccountId,
          } satisfies ProcessAttachmentPayload),
        ),
      );

      // Send notification for user uploads
      // This is a non-critical operation, so we don't await it
      if (input.length > 0) {
        try {
          await tasks.trigger("notification", {
            type: "inbox_new",
            teamId: teamId!,
            totalCount: input.length,
            inboxType: "upload",
          } satisfies NotificationInput);
        } catch (error) {
          // Don't fail the entire process if notification fails
          logger.warn("Failed to trigger inbox_new notification", {
            teamId: teamId!,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }

      return {
        jobs: jobResults.map((result) => ({ id: result.id })),
      };
    }),

  search: protectedProcedure
    .input(searchInboxSchema)
    .query(async ({ ctx: { db, teamId }, input }) => {
      const { q, transactionId, limit = 10 } = input;

      return getInboxSearch(db, {
        teamId: teamId!,
        q,
        transactionId,
        limit,
      });
    }),

  update: protectedProcedure
    .input(updateInboxSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      return updateInbox(db, { ...input, teamId: teamId! });
    }),

  matchTransaction: protectedProcedure
    .input(matchTransactionSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      return matchTransaction(db, { ...input, teamId: teamId! });
    }),

  unmatchTransaction: protectedProcedure
    .input(unmatchTransactionSchema)
    .mutation(async ({ ctx: { db, teamId, session }, input }) => {
      return unmatchTransaction(db, {
        id: input.id,
        teamId: teamId!,
        userId: session.user.id,
      });
    }),

  // Get inbox items by status
  getByStatus: protectedProcedure
    .input(getInboxByStatusSchema)
    .query(async ({ ctx: { db, teamId }, input }) => {
      return getInboxByStatus(db, {
        teamId: teamId!,
        status: input.status,
      });
    }),

  // Confirm a match suggestion
  confirmMatch: protectedProcedure
    .input(confirmMatchSchema)
    .mutation(async ({ ctx: { db, teamId, session }, input }) => {
      return confirmSuggestedMatch(db, {
        teamId: teamId!,
        suggestionId: input.suggestionId,
        inboxId: input.inboxId,
        transactionId: input.transactionId,
        userId: session.user.id,
      });
    }),

  // Decline a match suggestion
  declineMatch: protectedProcedure
    .input(declineMatchSchema)
    .mutation(async ({ ctx: { db, session, teamId }, input }) => {
      return declineSuggestedMatch(db, {
        suggestionId: input.suggestionId,
        inboxId: input.inboxId,
        userId: session.user.id,
        teamId: teamId!,
      });
    }),

  // Retry matching for an inbox item
  retryMatching: protectedProcedure
    .input(retryMatchingSchema)
    .mutation(async ({ ctx: { teamId }, input }) => {
      const result = await tasks.trigger("batch-process-matching", {
        teamId: teamId!,
        inboxIds: [input.id],
      } satisfies BatchProcessMatchingPayload);

      return { jobId: result.id };
    }),

  // Process an item again after its first attempt failed
  retryProcessing: protectedProcedure
    .input(retryProcessingSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      const item = await getInboxForReprocessing(db, {
        id: input.id,
        teamId: teamId!,
      });

      if (!item) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Inbox item not found",
        });
      }

      if (!item.filePath?.length || !item.size) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Inbox item has no stored file to process",
        });
      }

      // Triggered before the status is moved back, so a trigger that fails
      // leaves the item where the user found it rather than back on a spinner
      // with no job behind it.
      const result = await tasks.trigger("process-attachment", {
        filePath: item.filePath,
        mimetype: item.contentType ?? "application/octet-stream",
        size: item.size,
        teamId: teamId!,
        referenceId: item.referenceId ?? undefined,
        website: item.website ?? undefined,
        senderEmail: item.senderEmail ?? undefined,
        inboxAccountId: item.inboxAccountId ?? undefined,
      } satisfies ProcessAttachmentPayload);

      await updateInbox(db, {
        id: item.id,
        teamId: teamId!,
        status: "processing",
      });

      return { jobId: result.id };
    }),

  // Blocklist management
  blocklist: createTRPCRouter({
    get: protectedProcedure
      .input(getInboxBlocklistSchema)
      .query(async ({ ctx: { db, teamId } }) => {
        return getInboxBlocklist(db, {
          teamId: teamId!,
        });
      }),

    create: protectedProcedure
      .input(createInboxBlocklistSchema)
      .mutation(async ({ ctx: { db, teamId }, input }) => {
        return createInboxBlocklist(db, {
          teamId: teamId!,
          type: input.type,
          value: input.value,
        });
      }),

    delete: protectedProcedure
      .input(deleteInboxBlocklistSchema)
      .mutation(async ({ ctx: { db, teamId }, input }) => {
        return deleteInboxBlocklist(db, {
          id: input.id,
          teamId: teamId!,
        });
      }),
  }),
});
