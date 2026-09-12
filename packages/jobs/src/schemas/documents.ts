import { z } from "zod";

/**
 * Document job schemas (independent from @midday/jobs)
 */

export const processDocumentSchema = z.object({
  mimetype: z.string(),
  filePath: z.array(z.string()),
  teamId: z.string().uuid(),
  /**
   * Whether this document's arrival is worth telling anyone about.
   *
   * True for everything a person did — an upload, a mailbox attachment — where
   * the activity feed is how they see it land. False for a bulk import: the
   * Yuki pull (FF-1450) brings in hundreds of invoices the accountant has
   * already dealt with, and an activity each would bury everything else in the
   * feed to announce work nobody has to do.
   *
   * It silences the feed, not the processing: the title, the summary and the
   * tags are written either way.
   */
  notify: z.boolean().default(true),
});

export type ProcessDocumentPayload = z.infer<typeof processDocumentSchema>;

/**
 * What a *caller* sends, which is the same thing without the fields that
 * default. A trigger site should say this rather than the payload the run
 * receives, or adding a defaulted field breaks every caller that was correct.
 */
export type ProcessDocumentInput = z.input<typeof processDocumentSchema>;

export const classifyImageSchema = z.object({
  teamId: z.string().uuid(),
  fileName: z.string(),
});

export type ClassifyImagePayload = z.infer<typeof classifyImageSchema>;

export const classifyDocumentSchema = z.object({
  content: z.string(),
  fileName: z.string(),
  teamId: z.string().uuid(),
});

export type ClassifyDocumentPayload = z.infer<typeof classifyDocumentSchema>;

export const embedDocumentTagsSchema = z.object({
  documentId: z.string().uuid(),
  teamId: z.string().uuid(),
  tags: z.array(z.string()).min(1),
});

export type EmbedDocumentTagsPayload = z.infer<typeof embedDocumentTagsSchema>;
