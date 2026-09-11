import { createClient } from "@midday/supabase/job";
import { isFlagEnabled } from "@midday/utils/flags";
import { logger, schedules } from "@trigger.dev/sdk";
import { syncConnection } from "../sync/connection";

// This is a fan-out pattern. We want to trigger a job for each bank connection
// Then in sync connection we check if the connection is connected and if not we update the status (Connected, Disconnected)
export const bankSyncScheduler = schedules.task({
  id: "bank-sync-scheduler",
  maxDuration: 120,
  run: async (payload) => {
    if (!isFlagEnabled("BANK_SYNC_SCHEDULER_ENABLED")) {
      logger.info("Skipping bank sync: BANK_SYNC_SCHEDULER_ENABLED is off");
      return;
    }

    const supabase = createClient();

    const teamId = payload.externalId;

    if (!teamId) {
      throw new Error("teamId is required");
    }

    try {
      const { data: bankConnections } = await supabase
        .from("bank_connections")
        .select("id")
        .eq("team_id", teamId)
        .throwOnError();

      const formattedConnections = bankConnections?.map((connection) => ({
        payload: {
          connectionId: connection.id,
        },
        tags: ["team_id", teamId],
      }));

      if (formattedConnections?.length) {
        await syncConnection.batchTrigger(formattedConnections);
        return;
      }
    } catch (error) {
      logger.error("Failed to sync bank connections", { error });

      throw error;
    }

    // A team with no connections left — its last one deleted, or the team
    // itself — has nothing to sync again: a new connection gets a new schedule
    // from its initial setup. Removing this one frees one of the free plan's
    // ten slots.
    logger.info("No bank connections to sync; removing this schedule", {
      teamId,
      scheduleId: payload.scheduleId,
    });
    await schedules.del(payload.scheduleId);
  },
});
