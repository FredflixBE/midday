import { BaseProcessor } from "@jobs/processors/base";
import { runProcessor } from "@jobs/processors/run";
import type { JobContext } from "@jobs/processors/types";
import { type DeleteTeamPayload, deleteTeamSchema } from "@jobs/schemas/teams";
import { deleteSchedulesFor } from "@jobs/utils/schedules";
import { trpc } from "@midday/trpc";
import { schemaTask } from "@trigger.dev/sdk";

/**
 * Delete team processor
 *
 * Handles cleanup tasks when a team is deleted:
 * - Delete bank connections via banking API
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
    });

    await deleteSchedulesFor([
      teamId,
      ...inboxAccounts.map((account) => account.id),
    ]);

    // Delete bank connections
    const connectionsDeleted = await this.deleteBankConnections(
      teamId,
      connections,
    );

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
  retry: { maxAttempts: 3, minTimeoutInMs: 2000, factor: 2 },
  run: (payload, { ctx }) =>
    runProcessor(processor, "delete-team", payload, ctx),
});
