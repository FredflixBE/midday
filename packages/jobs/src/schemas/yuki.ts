import { z } from "zod";

/**
 * Yuki job schemas
 */

export const computeYukiGapSchema = z.object({
  /** The Midday team whose inbox answers for the configured Yuki administration. */
  teamId: z.string().uuid(),
});

export type ComputeYukiGapPayload = z.infer<typeof computeYukiGapSchema>;
