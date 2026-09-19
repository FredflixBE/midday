import { z } from "@hono/zod-openapi";

/** Per hour, never negative, to the cent. */
const hourlyRateSchema = z.number().min(0).multipleOf(0.01).max(99_999_999);

const nameSchema = z.string().trim().min(1).max(100);

export const listWorkTypesSchema = z
  .object({ includeArchived: z.boolean().optional() })
  .optional();

export const createWorkTypeSchema = z.object({
  name: nameSchema,
  hourlyRate: hourlyRateSchema,
});

export const updateWorkTypeSchema = z.object({
  id: z.string().uuid(),
  name: nameSchema.optional(),
  hourlyRate: hourlyRateSchema.optional(),
});

export const reorderWorkTypesSchema = z.object({
  ids: z.array(z.string().uuid()).max(500),
});

export const workTypeIdSchema = z.object({ id: z.string().uuid() });

export const customerWorkTypeRatesSchema = z.object({
  customerId: z.string().uuid(),
});

export const setCustomerWorkTypeRateSchema = z.object({
  customerId: z.string().uuid(),
  workTypeId: z.string().uuid(),
  /** Null clears the customer's own rate, so the default applies again. */
  hourlyRate: hourlyRateSchema.nullable(),
});
