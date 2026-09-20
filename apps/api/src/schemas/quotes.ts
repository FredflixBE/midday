import { z } from "@hono/zod-openapi";
import { blockSchema, quoteContentSchema } from "@midday/quote";

export const quoteKindSchema = z.enum(["project", "recurring"]);
export const quoteLanguageSchema = z.enum(["nl", "en"]);
export const quoteModeSchema = z.enum(["estimate", "firm"]);

const titleSchema = z.string().trim().min(1).max(300);

export const createQuoteSchema = z.object({
  customerId: z.string().uuid(),
  title: titleSchema,
  kind: quoteKindSchema,
  language: quoteLanguageSchema,
  currency: z.string().length(3).optional(),
  mode: quoteModeSchema.optional(),
});

export const quoteIdSchema = z.object({ id: z.string().uuid() });

/**
 * A draft's changes. The content is checked here for its shape, and again
 * against the quote's kind where it is written.
 */
export const updateQuoteDraftSchema = z.object({
  versionId: z.string().uuid(),
  title: titleSchema.optional(),
  kind: quoteKindSchema.optional(),
  language: quoteLanguageSchema.optional(),
  customerId: z.string().uuid().optional(),
  mode: quoteModeSchema.optional(),
  issueDate: z.string().date().optional(),
  validUntil: z.string().date().optional(),
  content: quoteContentSchema.optional(),
  internalNote: z.string().max(10_000).nullable().optional(),
});

export const reviseQuoteSchema = z.object({ quoteId: z.string().uuid() });

export const listQuotesSchema = z
  .object({
    status: z
      .enum(["draft", "awaiting", "expiring", "expired", "won", "lost"])
      .optional(),
  })
  .optional();

/** Sent by hand (v1 goes through Gmail): when, and optionally to whom. */
export const markQuoteSentSchema = z.object({
  versionId: z.string().uuid(),
  sentTo: z.string().trim().max(500).nullable().optional(),
});

/**
 * What a client answered (FF-1615), recorded by hand: the scenario they
 * took, the optional items that came along, who said so and when, the PO
 * number, and where the order form was stored in the vault.
 */
export const acceptQuoteSchema = z.object({
  versionId: z.string().uuid(),
  scenarioId: z.string().min(1).max(200),
  optionalLineIds: z.array(z.string().min(1).max(200)).max(500).optional(),
  acceptedAt: z.string().date().optional(),
  acceptedByName: z.string().trim().max(300).nullable().optional(),
  poNumber: z.string().trim().max(100).nullable().optional(),
  acceptanceFilePath: z
    .array(z.string().min(1).max(300))
    .min(2)
    .max(10)
    .nullable()
    .optional(),
});

/** Won is recorded by accepting a version (FF-1615), not here. */
export const setQuoteOutcomeSchema = z.object({
  quoteId: z.string().uuid(),
  outcome: z.enum(["open", "lost", "no_decision"]),
  reason: z.string().trim().max(2000).nullable(),
});

/**
 * A version of the team's general terms (FF-1616). The file is uploaded to
 * the vault first; this records it under the label it is known by.
 */
export const addQuoteTermsSchema = z.object({
  label: z.string().trim().min(1).max(50),
  language: quoteLanguageSchema,
  filePath: z.array(z.string().min(1).max(300)).min(2).max(10),
  fileName: z.string().trim().min(1).max(300),
});

export const quoteTermsIdSchema = z.object({ id: z.string().uuid() });

export const updateQuoteSettingsSchema = z.object({
  numberPrefix: z.string().trim().min(1).max(20).optional(),
  defaultValidDays: z.number().int().min(1).max(365).optional(),
  hoursPerDay: z.number().gt(0).max(24).multipleOf(0.01).optional(),
  defaultBlocks: z.array(blockSchema).optional(),
  labels: z.record(z.string(), z.record(z.string(), z.string())).optional(),
});
