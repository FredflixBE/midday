import type { Database } from "@midday/db/client";
import {
  getBankConnections,
  getInboxAccountCredentials,
} from "@midday/db/queries";
import type { DeleteTeamPayload } from "@midday/jobs/schemas/teams";
import { tasks } from "@trigger.dev/sdk";

/**
 * Start the cleanup of a team that is about to be deleted, from its settings
 * or along with its only member's account.
 *
 * Call it BEFORE deleting the team, so that if Trigger.dev is unreachable the
 * team stays intact and the user can retry. The job waits for the delete to
 * commit, then removes what the cascade cannot reach: schedules, stored files,
 * inbox access and bank connections. Both lists go in the payload because
 * their rows cascade away with the team. Subscription cancellation is done by
 * the user in the customer portal beforehand.
 */
export async function startTeamCleanup(db: Database, teamId: string) {
  const [bankConnections, inboxAccounts] = await Promise.all([
    getBankConnections(db, { teamId }),
    getInboxAccountCredentials(db, teamId),
  ]);

  return tasks.trigger("delete-team", {
    teamId,
    connections: bankConnections.map((c) => ({
      referenceId: c.referenceId,
      provider: c.provider,
      accessToken: c.accessToken,
    })),
    inboxAccounts,
  } satisfies DeleteTeamPayload);
}
