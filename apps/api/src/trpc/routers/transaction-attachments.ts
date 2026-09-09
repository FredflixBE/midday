import {
  createAttachmentsSchema,
  deleteAttachmentSchema,
  processTransactionAttachmentSchema,
} from "@api/schemas/transaction-attachments";
import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import { createAttachments, deleteAttachment } from "@midday/db/queries";
import { allowedMimeTypes } from "@midday/documents/utils";
import type { ProcessTransactionAttachmentPayload } from "@midday/jobs/schemas/transactions";
import { tasks } from "@trigger.dev/sdk";

export const transactionAttachmentsRouter = createTRPCRouter({
  createMany: protectedProcedure
    .input(createAttachmentsSchema)
    .mutation(async ({ input, ctx: { db, teamId, session } }) => {
      return createAttachments(db, {
        teamId: teamId!,
        userId: session.user.id,
        attachments: input,
      });
    }),

  delete: protectedProcedure
    .input(deleteAttachmentSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      return deleteAttachment(db, {
        id: input.id,
        teamId: teamId!,
      });
    }),

  processAttachment: protectedProcedure
    .input(processTransactionAttachmentSchema)
    .mutation(async ({ input, ctx: { teamId } }) => {
      const allowedAttachments = input.filter((item) =>
        allowedMimeTypes.includes(item.mimetype),
      );

      if (allowedAttachments.length === 0) {
        return;
      }

      // Trigger processing for each attachment
      const jobResults = await Promise.all(
        allowedAttachments.map((item) =>
          tasks.trigger("process-transaction-attachment", {
            filePath: item.filePath,
            mimetype: item.mimetype,
            teamId: teamId!,
            transactionId: item.transactionId,
          } satisfies ProcessTransactionAttachmentPayload),
        ),
      );

      return {
        jobs: jobResults.map((result) => ({ id: result.id })),
      };
    }),
});
