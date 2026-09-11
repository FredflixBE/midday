import { z } from "@hono/zod-openapi";

export const connectInboxAccountSchema = z.object({
  provider: z.enum(["gmail", "outlook"]),
  redirectPath: z.string().optional(),
  // The date the first sync reads from (YYYY-MM-DD); 30 days back when absent.
  since: z.string().optional(),
});

export const exchangeCodeForAccountSchema = z.object({
  code: z.string(),
  provider: z.enum(["gmail", "outlook"]),
});

export const deleteInboxAccountSchema = z.object({ id: z.string() });

export const syncInboxAccountSchema = z.object({
  id: z.string(),
  manualSync: z.boolean().optional(),
});
