import { getDb } from "@jobs/init";
import { deleteSchedulesFor } from "@jobs/utils/schedules";
import { getBankConnections } from "@midday/db/queries";
import { deleteConnectionSchema } from "@midday/jobs/schema";
import { trpc } from "@midday/trpc";
import { logger, schemaTask } from "@trigger.dev/sdk";

export const deleteConnection = schemaTask({
  id: "delete-connection",
  schema: deleteConnectionSchema,
  maxDuration: 60,
  queue: {
    concurrencyLimit: 5,
  },
  run: async (payload) => {
    const { teamId, referenceId, provider, accessToken } = payload;

    // The connection's row is deleted before this runs. If it was the team's
    // last, its daily bank sync has nothing left to do, and on the free plan
    // the schedule holds one of only ten slots. A connection added again
    // later gets a new schedule from its initial setup.
    const remaining = await getBankConnections(getDb(), { teamId });

    if (remaining.length === 0) {
      const deleted = await deleteSchedulesFor([teamId]);
      logger.info(
        "Deleted the bank sync schedule of a team with no connections",
        {
          teamId,
          deleted,
        },
      );
    }

    await trpc.banking.deleteConnection.mutate({
      id: referenceId!,
      provider,
      accessToken: accessToken ?? undefined,
    });
  },
});
