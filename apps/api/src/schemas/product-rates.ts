import { z } from "@hono/zod-openapi";

/** Per hour, never negative, to the cent. */
const hourlyRateSchema = z.number().min(0).multipleOf(0.01).max(99_999_999);

export const customerProductRatesSchema = z.object({
  customerId: z.string().uuid(),
});

export const setCustomerProductRateSchema = z.object({
  customerId: z.string().uuid(),
  productId: z.string().uuid(),
  /** Null clears the customer's own rate, so the product's price applies. */
  hourlyRate: hourlyRateSchema.nullable(),
});
