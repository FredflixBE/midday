import { z } from "zod";

/**
 * Yuki job schemas
 */

export const yukiDecideDeliverySchema = z.object({
  /** The team whose inbox is decided against its own Yuki connection. */
  teamId: z.string().uuid(),
});

export type YukiDecideDeliveryPayload = z.infer<
  typeof yukiDecideDeliverySchema
>;
