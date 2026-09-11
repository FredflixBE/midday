import { getDb } from "@jobs/init";
import { BaseProcessor } from "@jobs/processors/base";
import { handleJob } from "@jobs/processors/run";
import type { JobContext } from "@jobs/processors/types";
import { type DeleteTeamPayload, deleteTeamSchema } from "@jobs/schemas/teams";
import { deleteSchedulesByExternalId } from "@jobs/utils/schedules";
import { getTeamById } from "@midday/db/queries";
import { InboxConnector } from "@midday/inbox/connector";
import { createClient } from "@midday/supabase/job";
import { removeFolder } from "@midday/supabase/storage";
import { trpc } from "@midday/trpc";
import { schemaTask } from "@trigger.dev/sdk";

// The buckets that file a team's objects under a folder named for its id. The
// avatars bucket also holds user avatars, under the user's id; those outlive
// the team.
const TEAM_BUCKETS = ["vault", "avatars"];

/**
 * Delete team processor
 *
 * Deleting a team deletes everything tied to it. The database rows cascade
 * away with the team; this removes what lives outside the database:
 * - its sync schedules, and those of its inbox accounts
 * - its files in storage
 * - the app's access to its Gmail inboxes, at Google
 * - its bank connections, at the provider
 *
 * Every step runs even when another fails, and is safe to run twice, so a
 * failed run is retried whole. The exception is the bank connections: as
 * before, a provider that refuses a deletion is logged and not retried — an
 * expired connection is refused on every attempt, and the provider expires it
 * anyway.
 *
 * Note: Subscription cancellation is handled manually by the user via the
 * customer portal before team deletion. The UI prompts users to cancel
 * their subscription first.
 *
 * Data is passed in payload since team is deleted before job runs.
 */
export class DeleteTeamProcessor extends BaseProcessor<DeleteTeamPayload> {
  async process(job: JobContext<DeleteTeamPayload>): Promise<{
    teamId: string;
    connectionsDeleted: number;
  }> {
    const { teamId, connections, inboxAccounts } = job.data;

    this.logger.info("Starting team deletion cleanup", {
      jobId: job.id,
      teamId,
      connectionsCount: connections.length,
      inboxAccountsCount: inboxAccounts.length,
    });

    // The API starts this job before it deletes the team, so that a
    // Trigger.dev outage leaves the team whole rather than half-deleted. Every
    // step below is irreversible, so none may run until the team is really
    // gone: a delete that then failed would leave a live team without its
    // files, schedules or bank connections. Throwing spends a retry; a team
    // that never goes costs a failed run and nothing else.
    if (await getTeamById(getDb(), teamId)) {
      throw new Error(
        "The team still exists; waiting for its deletion to commit",
      );
    }

    const failures: unknown[] = [];

    const step = async <T>(name: string, work: () => Promise<T>) => {
      try {
        const result = await work();
        this.logger.info(`Team deletion: ${name}`, { teamId, result });
      } catch (error) {
        failures.push(error);
        this.logger.error(`Team deletion step failed: ${name}`, {
          teamId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    await step("schedules deleted", () =>
      deleteSchedulesByExternalId([
        teamId,
        ...inboxAccounts.map(({ id }) => id),
      ]),
    );

    const supabase = createClient();

    for (const bucket of TEAM_BUCKETS) {
      await step(`files removed from ${bucket}`, () =>
        removeFolder(supabase, { bucket, path: [teamId] }),
      );
    }

    for (const account of inboxAccounts) {
      await step(`inbox access for ${account.provider}`, () =>
        new InboxConnector(account.provider, getDb()).revokeAccess(account),
      );
    }

    // Delete bank connections
    const connectionsDeleted = await this.deleteBankConnections(
      teamId,
      connections,
    );

    if (failures.length === 1) throw failures[0];

    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        failures
          .map((error) => (error instanceof Error ? error.message : error))
          .join("; "),
      );
    }

    this.logger.info("Team deletion cleanup completed", {
      teamId,
      connectionsDeleted,
    });

    return {
      teamId,
      connectionsDeleted,
    };
  }

  private async deleteBankConnections(
    teamId: string,
    connections: DeleteTeamPayload["connections"],
  ): Promise<number> {
    if (connections.length === 0) {
      this.logger.info("No bank connections to delete", { teamId });
      return 0;
    }

    this.logger.info("Deleting bank connections", {
      teamId,
      count: connections.length,
    });

    const deletePromises = connections.map(async (connection) => {
      if (!connection.referenceId) {
        return false;
      }

      try {
        await trpc.banking.deleteConnection.mutate({
          id: connection.referenceId,
          provider: connection.provider as "gocardless" | "enablebanking",
          accessToken: connection.accessToken ?? undefined,
        });
        return true;
      } catch (error) {
        this.logger.warn("Failed to delete connection from provider", {
          teamId,
          referenceId: connection.referenceId,
          provider: connection.provider,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        return false;
      }
    });

    const results = await Promise.all(deletePromises);
    const deletedCount = results.filter(Boolean).length;

    this.logger.info("Bank connections deletion completed", {
      teamId,
      attempted: connections.length,
      deleted: deletedCount,
    });

    return deletedCount;
  }
}

const processor = new DeleteTeamProcessor();

export const deleteTeam = schemaTask({
  id: "delete-team",
  schema: deleteTeamSchema,
  maxDuration: 300,
  queue: { concurrencyLimit: 5 },
  // Five attempts wait 2, 4, 8 and 16 seconds between them: half a minute for
  // the team's deletion to commit before the run gives up on it.
  retry: { maxAttempts: 5, minTimeoutInMs: 2000, factor: 2 },
  // handleJob, not runProcessor: runProcessor stops the run on any error whose
  // message reads as permanent ("invalid", "not found", "400"…). Here every
  // step is safe to repeat, and one run's error may combine a permanent-looking
  // failure in one step with a transient one in another, so every failure gets
  // the remaining attempts.
  run: (payload, { ctx }) => handleJob(processor, "delete-team", payload, ctx),
});
