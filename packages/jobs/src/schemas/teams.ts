import { z } from "zod";

/**
 * Team job schemas
 */

const bankConnectionSchema = z.object({
  referenceId: z.string().nullable(),
  provider: z.string(),
  accessToken: z.string().nullable(),
});

const inboxAccountSchema = z.object({
  id: z.string().uuid(),
  provider: z.enum(["gmail", "outlook"]),
  email: z.string(),
  // Still encrypted, as the database stores it: Trigger.dev keeps payloads and
  // shows them in its dashboard.
  refreshToken: z.string(),
});

export const deleteTeamSchema = z.object({
  teamId: z.string().uuid(),
  connections: z.array(bankConnectionSchema),
  inboxAccounts: z.array(inboxAccountSchema),
});

export type DeleteTeamPayload = z.infer<typeof deleteTeamSchema>;
