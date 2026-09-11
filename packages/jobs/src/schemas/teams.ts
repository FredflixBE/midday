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
  // None, when an API one version behind sends no inbox accounts: the API and
  // the worker deploy separately, and a rejected payload skips the whole
  // cleanup. Their schedules still remove themselves on their next run; only
  // revoking their access is lost. The parsed type still requires the field,
  // so the current API cannot forget it.
  inboxAccounts: z.array(inboxAccountSchema).default([]),
});

export type DeleteTeamPayload = z.infer<typeof deleteTeamSchema>;
