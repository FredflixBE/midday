import { processAttachmentSchema } from "@jobs/schema";
import { z } from "zod";

/**
 * Payload schemas for the inbox tasks.
 *
 * `processAttachmentSchema` lives in `@jobs/schema` because the API and the
 * dashboard type their dispatches against it; it is re-exported here so every
 * inbox task reads its schema from one place.
 */
export { processAttachmentSchema };

export type ProcessAttachmentPayload = z.infer<typeof processAttachmentSchema>;

export const batchProcessMatchingSchema = z.object({
  teamId: z.string().uuid(),
  inboxIds: z.array(z.string().uuid()),
});

export type BatchProcessMatchingPayload = z.infer<
  typeof batchProcessMatchingSchema
>;

export const matchTransactionsBidirectionalSchema = z.object({
  teamId: z.string().uuid(),
  newTransactionIds: z.array(z.string().uuid()),
});

export type MatchTransactionsBidirectionalPayload = z.infer<
  typeof matchTransactionsBidirectionalSchema
>;

export const slackUploadSchema = z.object({
  teamId: z.string(),
  token: z.string(),
  channelId: z.string(),
  threadId: z.string().optional(),
  // Message timestamp, used to attach reactions to the original upload.
  messageTs: z.string().optional(),
  file: z.object({
    id: z.string(),
    name: z.string(),
    mimetype: z.string(),
    size: z.number(),
    url: z.string(),
  }),
});

export type SlackUploadPayload = z.infer<typeof slackUploadSchema>;
