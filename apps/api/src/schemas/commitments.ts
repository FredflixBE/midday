import { z } from "@hono/zod-openapi";

export const commitmentKindSchema = z.enum([
  "subscription",
  "direct_debit",
  "leasing",
  "tax",
]);

export const commitmentCadenceSchema = z.enum([
  "monthly",
  "quarterly",
  "yearly",
]);

export const commitmentPriceKindSchema = z.enum([
  "fixed",
  "fixed_foreign",
  "usage",
]);

export const commitmentStatusSchema = z.enum([
  "proposed",
  "active",
  "rejected",
  "ended",
]);

export const listCommitmentsSchema = z
  .object({ supplierId: z.string().uuid().optional() })
  .optional();

export const updateCommitmentSchema = z.object({
  id: z.string().uuid(),
  kind: commitmentKindSchema.optional(),
  cadence: commitmentCadenceSchema.optional(),
  day: z.number().int().min(1).max(31).optional(),
  priceKind: commitmentPriceKindSchema.optional(),
  amount: z.number().optional(),
  amountLow: z.number().nullable().optional(),
  amountHigh: z.number().nullable().optional(),
  status: commitmentStatusSchema.optional(),
  endsOn: z.string().date().nullable().optional(),
});

export const setTransactionCommitmentSchema = z.object({
  transactionId: z.string().uuid(),
  /** Null says this payment is part of no commitment. */
  commitmentId: z.string().uuid().nullable(),
});
